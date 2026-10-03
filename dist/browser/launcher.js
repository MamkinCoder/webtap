// Chromium launch + Stagehand.create with the injected LLM.
// APIs used (see node_modules/@browserbasehq/stagehand/dist/index.d.mts):
//   localBrowser.launch(LocalBrowserLaunchOptions)  → StagehandBrowser  (spawns Chromium over CDP)
//   Stagehand.create({ browser, model: { generate }, selfHeal, logging, telemetry, domSettleTimeoutMs })
//   browser.context.pages() / newPage()
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { adaptLLM } from "./adapter.js";
import { ActionCache } from "./cache.js";
import { installUrlBlocker } from "./cdp.js";
import { startProxyRelay } from "./proxy-relay.js";
import { StagehandSession } from "./session.js";
const DEFAULT_VIEWPORT = { width: 1366, height: 850 };
const DEFAULT_LANGUAGES = ["ru-RU", "ru", "en-US", "en"];
const DISK_CACHE_BYTES = 50_000_000;
const DOM_SETTLE_MS = 3_000;
// Not included on purpose: --no-sandbox, --single-process (RAM/security), and --disable-extensions —
// Stagehand v4 IS a Chrome extension (Extensions.loadUnpacked over CDP), so disabling extensions kills it.
const CHROMIUM_ARGS = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--renderer-process-limit=2",
    // navigator.webdriver and friends: anti-bot checks (WB's wbaas, reCAPTCHA) read them.
    "--disable-blink-features=AutomationControlled",
    // Headless reports no WebGL: a bot tell.
    "--enable-unsafe-swiftshader",
];
const XVFB = "/usr/bin/Xvfb";
const XVFB_DISPLAY = ":99";
const XVFB_SCREEN = { width: 1920, height: 1080 };
const XPROP = "/usr/bin/xprop";
let xvfbStarted;
/** A visible (headful) Chrome needs a screen. On a Linux box without one this starts one virtual screen, Xvfb, for
 * the life of the process and points DISPLAY at it; Chrome inherits the env. False when there is no display and no
 * Xvfb: the caller falls back to headless. */
export function ensureDisplay() {
    if (process.platform !== "linux" || process.env.DISPLAY)
        return Promise.resolve(true);
    if (!existsSync(XVFB))
        return Promise.resolve(false);
    xvfbStarted ??= (async () => {
        const child = spawn(XVFB, [XVFB_DISPLAY, "-screen", "0", `${XVFB_SCREEN.width}x${XVFB_SCREEN.height}x24`, "-nolisten", "tcp", "-noreset"], { stdio: "ignore", detached: false });
        child.unref();
        let exited = false;
        child.once("exit", () => {
            exited = true;
            xvfbStarted = undefined; // gone: the next headful launch starts a new one
            if (process.env.DISPLAY === XVFB_DISPLAY)
                delete process.env.DISPLAY;
        });
        await sleep(1000); // Xvfb takes a moment to accept clients
        if (exited)
            return false;
        process.env.DISPLAY = XVFB_DISPLAY;
        // A bare Xvfb has no desktop panel, so screen.avail* equals screen.* (anti-bot scripts read that as "no
        // taskbar": a headless tell). Reserve a 32px bottom panel the way a desktop's window manager does (needs xprop;
        // -noreset above keeps the property when the last client disconnects).
        if (existsSync(XPROP)) {
            try {
                execFileSync(XPROP, ["-root", "-f", "_NET_WORKAREA", "32c", "-set", "_NET_WORKAREA", `0,0,${XVFB_SCREEN.width},${XVFB_SCREEN.height - 32}`], { timeout: 5_000, stdio: "ignore" });
            }
            catch {
                // cosmetic: Chrome then reports the whole screen as available
            }
        }
        return true;
    })();
    return xvfbStarted;
}
/** True when Chrome draws on the Xvfb screen webtap started (a server without a GPU), not on a real display. */
export function onVirtualDisplay() {
    return process.platform === "linux" && process.env.DISPLAY === XVFB_DISPLAY;
}
const CHROME_CANDIDATES = {
    darwin: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
    win32: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
};
/** The first installed Chrome / Chromium in the usual places. Needed up front: the desktop user agent is derived from
 * the binary's version, and without it headless Chrome says "HeadlessChrome" (anti-bot checks reject it). */
export function findChrome() {
    return (CHROME_CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
}
const desktopUA = new Map();
/** The desktop user agent of this Chromium build, in Chrome's reduced form: headless says "HeadlessChrome" (a bot
 * tell sites read). Set as a launch flag, so navigator.userAgentData keeps the browser's own client hints. */
export function desktopUserAgent(executablePath) {
    if (!executablePath)
        return "";
    let ua = desktopUA.get(executablePath);
    if (ua === undefined) {
        let major = "";
        try {
            major = /(\d+)\.\d+\.\d+\.\d+/.exec(execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 }))?.[1] ?? "";
        }
        catch {
            // unknown build: keep Chromium's own user agent
        }
        // Chrome's reduced UA: fixed platform tokens (x86_64 even on arm64 Linux, 10_15_7 on any macOS).
        const platform = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
        ua = major ? `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` : "";
        desktopUA.set(executablePath, ua);
    }
    return ua;
}
/** Stand-in model for runtimes without an LLM: http / page-fetch strategies work, act-on-miss / observe / extract fail. */
const NO_LLM = {
    generate: () => Promise.reject(new Error("webtap: no LLM configured (needed for act on a cache miss, observe and extract)")),
};
export function createLauncher(llm = NO_LLM) {
    const generate = adaptLLM(llm);
    return {
        async launch(opts) {
            const cleanup = [];
            const diskCacheDir = await mkdtemp(join(tmpdir(), "webtap-chromium-cache-"));
            cleanup.push(() => rm(diskCacheDir, { recursive: true, force: true }));
            const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
            const languages = opts.languages?.length ? opts.languages : DEFAULT_LANGUAGES;
            const executablePath = opts.executablePath || findChrome();
            const ua = opts.userAgent || desktopUserAgent(executablePath);
            const headless = opts.headless || !(await ensureDisplay());
            // Stagehand's local browser takes no proxy credentials: put a local relay in front of an authenticated proxy.
            let proxy = opts.proxy;
            if (proxy && (proxy.username || proxy.password)) {
                const relay = await startProxyRelay(proxy);
                cleanup.push(() => relay.close());
                proxy = { server: relay.server };
            }
            const browser = await localBrowser
                .launch({
                ...(executablePath ? { executablePath } : {}),
                userDataDir: opts.userDataDir,
                preserveUserDataDir: true,
                // Headful needs a screen: a virtual one on a bare Linux box, else headless.
                headless,
                ignoreDefaultArgs: ["--enable-automation"],
                ...(proxy ? { proxy } : {}),
                locale: languages[0],
                args: [
                    ...CHROMIUM_ARGS,
                    // A proxy-less identity browses direct: Linux Chromium would otherwise honour HTTP(S)_PROXY from the env.
                    ...(opts.proxy ? [] : ["--no-proxy-server"]),
                    `--lang=${languages[0]}`,
                    // Headless ignores --lang for navigator.languages / Accept-Language; this one it honours. Plain tags: q=
                    // weights would show up verbatim in navigator.languages.
                    `--accept-lang=${languages.join(",")}`,
                    `--window-size=${viewport.width},${viewport.height}`,
                    // Headless reports an 800x600 screen under a bigger window: a bot tell.
                    `--screen-info={${viewport.width}x${viewport.height + 50}}`,
                    ...(opts.blockAssets && !opts.loadImages ? ["--blink-settings=imagesEnabled=false"] : []),
                    ...(ua ? [`--user-agent=${ua}`] : []),
                    `--disk-cache-dir=${diskCacheDir}`,
                    `--disk-cache-size=${DISK_CACHE_BYTES}`,
                ],
                viewport: { ...viewport },
            })
                .catch(async (err) => {
                await Promise.allSettled(cleanup.map((fn) => fn()));
                throw err;
            });
            let stagehand;
            try {
                stagehand = await Stagehand.create({
                    browser,
                    model: { generate },
                    selfHeal: false, // replay failures are handled by our cache → observe fallback, not by hidden LLM calls
                    domSettleTimeoutMs: DOM_SETTLE_MS,
                    logging: { level: "error", format: "pretty" },
                    // The extension ships an OTLP exporter aimed at example.com; keep it quiet.
                    telemetry: { traces: { endpoint: "http://127.0.0.1:9/v1/traces", headers: {} } },
                });
            }
            catch (err) {
                await browser.close().catch(() => undefined);
                await Promise.allSettled(cleanup.map((fn) => fn()));
                throw err;
            }
            const pages = await browser.context.pages();
            const page = pages[0] ?? (await browser.context.newPage());
            if (opts.blockAssets || opts.blockUrls?.length) {
                const wsUrl = stagehand.rpcClient?.browserWebSocketDebuggerUrl;
                if (wsUrl) {
                    try {
                        cleanup.push(await installUrlBlocker(wsUrl, { assets: !!opts.blockAssets, images: !!opts.loadImages, extra: opts.blockUrls ?? [] }));
                    }
                    catch {
                        // blocking is an optimisation; keep going without it
                    }
                }
            }
            return new StagehandSession({
                stagehand,
                browser,
                page,
                opts,
                cache: opts.cache ?? new ActionCache(),
                cleanup,
                ...(stagehand.rpcClient?.browserWebSocketDebuggerUrl ? { cdpUrl: stagehand.rpcClient.browserWebSocketDebuggerUrl } : {}),
            });
        },
    };
}
//# sourceMappingURL=launcher.js.map