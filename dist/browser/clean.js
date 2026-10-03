// The "clean" engine: a plain Chrome that anti-bot scripts cannot tell from a person's.
//
// Avito (2026-10) bans the IP of any automated Chrome it detects, headless or not, while the same Chrome started by
// hand passes. What gives automation away is what drivers do INSIDE the page (Runtime.enable and friends, which
// Playwright/Stagehand call on every attach). So this engine:
//   - starts Chrome itself, without automation flags, with the site's page as its first url (opened by Chrome, not
//     by CDP), so the site's challenge (Avito's proof-of-work) runs in an untouched page;
//   - talks CDP at the browser level, and in the page only through single commands that need no domain enabled:
//     Page.navigate, Runtime.evaluate, Input.dispatchKeyEvent, Page.captureScreenshot.
// No Stagehand, so no natural-language act/extract/observe: sites on this engine use goto + evaluate (+ fetch).
// Windows are always on-screen (an off-screen window is a bot tell): on a server that is the Xvfb display.
// An identity with `remote` gets a tab in a browser that runs elsewhere instead (./remote.ts), driven the same way.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RawCdp } from "./cdp.js";
import { ensureDisplay, findChrome, onVirtualDisplay } from "./launcher.js";
import { chromiumTreeRssMB, killChromiumLeftovers } from "./memory.js";
import { startProxyRelay } from "./proxy-relay.js";
import { browserWsUrl, openRemoteTab } from "./remote.js";
import { RESOLVE_JS, TEXT_JS, fillJs, pageFetchJs } from "./session.js";
const DEFAULT_VIEWPORT = { width: 1366, height: 850 };
const DEFAULT_LANGUAGES = ["ru-RU", "ru", "en-US", "en"];
const unsupported = (what) => Promise.reject(new Error(`${what} needs the Stagehand engine; this site runs on the clean engine (goto + evaluate only)`));
/** LANG / LANGUAGE for a BCP 47 tag: "ru-RU" → ru_RU.UTF-8 and ru_RU:ru. */
export function localeEnv(tag) {
    const m = /^([a-z]{2,3})(?:-([A-Z]{2}))?/.exec(tag ?? "");
    if (!m)
        return {};
    const posix = m[2] ? `${m[1]}_${m[2]}` : m[1];
    return { LANG: `${posix}.UTF-8`, LANGUAGE: m[2] ? `${posix}:${m[1]}` : posix };
}
/** Sets one value in the profile's Default/Preferences before Chrome starts (Chrome keeps the other keys). */
export function setPreference(userDataDir, path, value) {
    const file = join(userDataDir, "Default", "Preferences");
    let prefs = {};
    try {
        prefs = JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        // new or unreadable profile: start from scratch
    }
    let node = prefs;
    for (const key of path.slice(0, -1)) {
        if (typeof node[key] !== "object" || node[key] === null)
            node[key] = {};
        node = node[key];
    }
    const last = path[path.length - 1];
    if (node[last] === value)
        return;
    node[last] = value;
    mkdirSync(join(userDataDir, "Default"), { recursive: true });
    writeFileSync(file, JSON.stringify(prefs));
}
/** The reduced user agent and client hints of Chrome `major` on `os`, as that Chrome sends them. */
export function personaFor(os, major) {
    const win = os === "windows";
    return {
        userAgent: `Mozilla/5.0 (${win ? "Windows NT 10.0; Win64; x64" : "Macintosh; Intel Mac OS X 10_15_7"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        platform: win ? "Win32" : "MacIntel",
        metadata: win
            ? { platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "64", model: "", mobile: false, wow64: false }
            : { platform: "macOS", platformVersion: "15.5.0", architecture: "arm", bitness: "64", model: "", mobile: false, wow64: false },
    };
}
/**
 * Makes this tab present `os`: user agent, Sec-CH-UA client hints and navigator.platform (Emulation, no domain to
 * enable, nothing the page can see being set). The version is this Chrome's own (Browser.getVersion) and the brand
 * list is left to Chrome, so only the OS differs from what the binary would say. (userAgentData can't be read on
 * about:blank: it exists in secure contexts only.)
 */
async function presentOs(cdp, sessionId, os) {
    const { product } = await cdp.send("Browser.getVersion");
    const fullVersion = /\/(\d+\.\d+\.\d+\.\d+)/.exec(product)?.[1];
    if (!fullVersion)
        throw new Error(`clean engine: no Chrome version in "${product}"`);
    const p = personaFor(os, fullVersion.split(".")[0]);
    const override = { userAgent: p.userAgent, platform: p.platform, userAgentMetadata: { fullVersion, ...p.metadata } };
    // Workers inherit the user agent, but not the platform: CDP can't change a worker's navigator.platform (an override
    // sent to the worker itself is accepted and ignored), so a worker still reports the real OS. Avito's firewall let
    // this exact setup through (2026-10-03).
    await cdp.send("Emulation.setUserAgentOverride", override, sessionId);
}
export function createCleanLauncher() {
    return {
        async launch(opts) {
            if (opts.remote)
                return launchRemote(opts, opts.remote);
            const cleanup = [];
            try {
                const executable = opts.executablePath || findChrome();
                if (!executable)
                    throw new Error("clean engine: no Chrome/Chromium found (set executablePath)");
                const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
                const languages = opts.languages?.length ? opts.languages : DEFAULT_LANGUAGES;
                const headless = opts.headless || !(await ensureDisplay());
                let proxyServer;
                if (opts.proxy) {
                    if (opts.proxy.username || opts.proxy.password) {
                        const relay = await startProxyRelay(opts.proxy);
                        cleanup.push(() => relay.close());
                        proxyServer = relay.server;
                    }
                    else
                        proxyServer = opts.proxy.server;
                }
                mkdirSync(opts.userDataDir, { recursive: true });
                // WebRTC sends STUN over UDP straight past an HTTP proxy, so a page sees the machine's own IP next to the
                // proxy's (on a server: a datacenter IP behind a mobile one). Keep WebRTC on the proxy, as uBlock does.
                if (proxyServer)
                    setPreference(opts.userDataDir, ["webrtc", "ip_handling_policy"], "disable_non_proxied_udp");
                const portFile = join(opts.userDataDir, "DevToolsActivePort");
                rmSync(portFile, { force: true });
                const args = [
                    `--user-data-dir=${opts.userDataDir}`,
                    "--remote-debugging-port=0",
                    // Chrome sets navigator.webdriver=true whenever a debugging port is open. The price is the "unsupported
                    // command-line flag" infobar, which many real browsers show in some form; webdriver=true none do.
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-background-networking",
                    "--disable-sync",
                    // No GPU on the Xvfb screen: Chrome then turns WebGL off altogether (no real browser lacks it). Mesa's
                    // software renderer (llvmpipe) instead, as on a Linux VM.
                    ...(!headless && onVirtualDisplay() ? ["--ignore-gpu-blocklist", "--use-angle=gl"] : []),
                    `--lang=${languages[0]}`,
                    `--accept-lang=${languages.join(",")}`,
                    `--window-size=${viewport.width},${viewport.height}`,
                    proxyServer ? `--proxy-server=${proxyServer}` : "--no-proxy-server",
                    // Chrome refuses to run as root (Docker) with its sandbox on.
                    ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
                    ...(headless ? ["--headless=new"] : []),
                    // Always on-screen: an off-screen window (screenX -32000) is itself a bot tell Avito acts on.
                    ...(opts.userAgent && !opts.os ? [`--user-agent=${opts.userAgent}`] : []),
                    // With a persona the site waits: its first request must already carry the presented OS.
                    opts.os ? "about:blank" : (opts.startUrl ?? "about:blank"),
                ];
                // Linux Chrome takes its UI locale (Intl's default: dates, numbers) from the environment, not from --lang; a
                // server's bare env gives en-US next to Russian Accept-Language.
                const env = { ...process.env };
                if (process.platform === "linux") {
                    delete env.LC_ALL; // would override LANG/LANGUAGE
                    delete env.LC_MESSAGES;
                    Object.assign(env, localeEnv(languages[0]));
                }
                const child = spawn(executable, args, { stdio: "ignore", env });
                cleanup.push(() => void child.kill("SIGTERM"));
                for (let i = 0; i < 150 && !existsSync(portFile); i++)
                    await sleep(100);
                if (!existsSync(portFile))
                    throw new Error("clean engine: Chrome did not open its debugging port");
                const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
                const cdp = await RawCdp.connect(`ws://127.0.0.1:${port}${path}`);
                cleanup.push(() => cdp.close());
                // The tab Chrome opened by itself.
                let targetId;
                for (let i = 0; i < 50 && !targetId; i++) {
                    const { targetInfos } = await cdp.send("Target.getTargets");
                    targetId = targetInfos.find((t) => t.type === "page")?.targetId;
                    if (!targetId)
                        await sleep(100);
                }
                if (!targetId)
                    throw new Error("clean engine: no page target");
                const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
                // With a persona Chrome opened about:blank: the site comes after the override.
                await prepareTab(cdp, sessionId, opts, opts.os, !!opts.os);
                return new CleanSession(cdp, sessionId, opts, cleanup, false);
            }
            catch (err) {
                for (const fn of cleanup.reverse())
                    await Promise.resolve(fn()).catch(() => undefined);
                throw err;
            }
        },
    };
}
/** Readies an attached tab: URL blocking, the persona, then (navigate) the site's first page. */
async function prepareTab(cdp, sessionId, opts, os, navigate) {
    // Blocking ads/video saves proxy traffic. The Network domain is invisible to the page (unlike Runtime).
    if (opts.blockUrls?.length) {
        await cdp.send("Network.enable", {}, sessionId);
        await cdp.send("Network.setBlockedURLs", { urls: opts.blockUrls }, sessionId);
    }
    if (os)
        await presentOs(cdp, sessionId, os);
    if (navigate && opts.startUrl)
        await cdp.send("Page.navigate", { url: opts.startUrl }, sessionId);
}
/**
 * A session in an already-running browser (./remote.ts): a fresh tab of its own, readied like a local one. The
 * browser's launch flags own the proxy, languages and window; a native persona (a stealth build) gets no UA override.
 * The site's first page is a Page.navigate from about:blank: the same first request as a local Chrome with a persona.
 */
async function launchRemote(opts, remote) {
    const cleanup = [];
    try {
        const cdp = await RawCdp.connect(await browserWsUrl(remote.cdpUrl));
        cleanup.push(() => cdp.close());
        const tab = await openRemoteTab(cdp, remote.cdpUrl);
        cleanup.push(tab.release);
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
        await prepareTab(cdp, sessionId, opts, remote.nativePersona ? undefined : opts.os, true);
        return new CleanSession(cdp, sessionId, opts, cleanup, true);
    }
    catch (err) {
        for (const fn of cleanup.reverse())
            await Promise.resolve(fn()).catch(() => undefined);
        throw err;
    }
}
class CleanSession {
    cdp;
    sessionId;
    opts;
    cleanup;
    remote;
    closing;
    constructor(cdp, sessionId, opts, cleanup, 
    /** Attached to a running browser (./remote.ts): close() leaves the browser alone. */
    remote) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.opts = opts;
        this.cleanup = cleanup;
        this.remote = remote;
    }
    send(method, params = {}) {
        return this.cdp.send(method, params, this.sessionId);
    }
    async evaluate(js) {
        // Runtime.evaluate needs no Runtime.enable: nothing in the page changes when it runs.
        const r = await this.send("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails)
            throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "error"}`);
        return r.result.value;
    }
    async goto(url, opts) {
        const before = await this.url().catch(() => "");
        await this.send("Page.navigate", { url });
        const deadline = Date.now() + Math.max(this.opts.actionTimeoutMs ?? 15_000, 30_000);
        let seenNew = false;
        while (Date.now() < deadline) {
            await sleep(250);
            const state = await this.evaluate("({ href: location.href, ready: document.readyState })").catch(() => null);
            if (!state)
                continue; // between documents
            if (state.href !== before || url === before)
                seenNew = true;
            if (seenNew && state.ready !== "loading") {
                // Interactive is enough (heavy pages keep loading ads and trackers forever); give "complete" a few seconds.
                if (!opts?.quick) {
                    const soft = Date.now() + 4_000;
                    while (Date.now() < soft && (await this.evaluate("document.readyState").catch(() => "")) !== "complete")
                        await sleep(250);
                }
                return;
            }
        }
        throw new Error(`navigation to ${url} did not finish`);
    }
    url() {
        return this.evaluate("location.href");
    }
    html() {
        return this.evaluate("document.documentElement.outerHTML");
    }
    text(maxChars = 20_000) {
        return this.evaluate(TEXT_JS(maxChars));
    }
    fetch(url, init = {}) {
        return this.evaluate(pageFetchJs(url, init));
    }
    act() {
        return unsupported("act()");
    }
    extract(_instruction, _schema) {
        return unsupported("extract()");
    }
    observe() {
        return unsupported("observe()");
    }
    async exists(selector) {
        return this.evaluate(`!!${RESOLVE_JS}(${JSON.stringify(selector)})`).catch(() => false);
    }
    async click(selector) {
        const ok = await this.evaluate(`(function(){var el=${RESOLVE_JS}(${JSON.stringify(selector)});if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true})()`);
        if (!ok)
            throw new Error(`no element for ${selector}`);
    }
    async fill(selector, value) {
        if (!(await this.evaluate(fillJs(selector, value))))
            throw new Error(`could not fill ${selector}`);
    }
    upload() {
        return unsupported("upload()");
    }
    async waitForText(text, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await this.evaluate(`(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`).catch(() => false))
                return true;
            if (Date.now() >= deadline)
                return false;
            await sleep(250);
        }
    }
    async waitForSelector(selector, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await this.exists(selector))
                return true;
            if (Date.now() >= deadline)
                return false;
            await sleep(250);
        }
    }
    async pressKey(key) {
        await this.send("Input.dispatchKeyEvent", { type: "keyDown", key });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", key });
    }
    pressEscape() {
        return this.pressKey("Escape");
    }
    async humanize(_targets, ms) {
        // Trusted wheel events (Input domain, no page instrumentation), then idle until ms has passed.
        const end = Date.now() + ms;
        try {
            for (let i = 0; i < 3 && Date.now() < end; i++) {
                await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400 + Math.random() * 300, y: 300 + Math.random() * 200, deltaX: 0, deltaY: 200 + Math.random() * 400 });
                await sleep(300 + Math.random() * 700);
            }
        }
        catch {
            // best effort
        }
        const left = end - Date.now();
        if (left > 0)
            await sleep(left);
    }
    async retype() {
        return false;
    }
    async snapshot(name) {
        const dir = this.opts.snapshotDir;
        mkdirSync(dir, { recursive: true });
        const base = join(dir, name.replace(/[^a-z0-9._-]/gi, "_"));
        writeFileSync(`${base}.html`, await this.html().catch(() => ""));
        writeFileSync(`${base}.url`, await this.url().catch(() => ""));
        try {
            const { data } = await this.send("Page.captureScreenshot", { format: "png" });
            writeFileSync(`${base}.png`, Buffer.from(data, "base64"));
        }
        catch {
            // the html snapshot still stands
        }
        return `${base}.html`;
    }
    async cookies() {
        const { cookies } = await this.cdp.send("Storage.getCookies");
        return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, ...(c.sameSite ? { sameSite: c.sameSite } : {}) }));
    }
    async setCookies(cookies) {
        if (cookies.length)
            await this.cdp.send("Storage.setCookies", { cookies });
    }
    memoryMB() {
        // A remote browser's processes are on another machine.
        return this.remote ? Promise.resolve(0) : chromiumTreeRssMB(this.opts.userDataDir);
    }
    close() {
        this.closing ??= (async () => {
            if (this.remote) {
                // Only the connection goes. The tab stays (closing a headful browser's last tab ends the browser) until the
                // next session of this browser replaces it; the profile keeps its cookies.
                for (const fn of this.cleanup.reverse())
                    await Promise.resolve(fn()).catch(() => undefined);
                return;
            }
            try {
                await Promise.race([this.cdp.send("Browser.close"), sleep(5_000)]);
            }
            catch {
                // already gone
            }
            for (const fn of this.cleanup.reverse())
                await Promise.resolve(fn()).catch(() => undefined);
            await killChromiumLeftovers(this.opts.userDataDir);
        })();
        return this.closing;
    }
}
//# sourceMappingURL=clean.js.map