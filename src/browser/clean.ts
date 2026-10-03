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
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ZodType } from "zod";
import type { ActResult, BrowserLauncher, BrowserOptions, BrowserSession, Cookie, Observed, PageFetchResult } from "../types.js";
import { RawCdp } from "./cdp.js";
import { ensureDisplay, findChrome } from "./launcher.js";
import { chromiumTreeRssMB, killChromiumLeftovers } from "./memory.js";
import { startProxyRelay } from "./proxy-relay.js";
import { RESOLVE_JS, TEXT_JS, fillJs, pageFetchJs } from "./session.js";

const DEFAULT_VIEWPORT = { width: 1366, height: 850 } as const;
const DEFAULT_LANGUAGES = ["ru-RU", "ru", "en-US", "en"];

const unsupported = (what: string) =>
  Promise.reject(new Error(`${what} needs the Stagehand engine; this site runs on the clean engine (goto + evaluate only)`));

export interface CleanLaunchOptions extends BrowserOptions {
  /** The first page Chrome opens by itself (before any CDP command touches a page). */
  startUrl?: string;
}

export function createCleanLauncher(): BrowserLauncher & { launch(opts: CleanLaunchOptions): Promise<BrowserSession> } {
  return {
    async launch(opts: CleanLaunchOptions): Promise<BrowserSession> {
      const cleanup: (() => Promise<void> | void)[] = [];
      try {
        const executable = opts.executablePath || findChrome();
        if (!executable) throw new Error("clean engine: no Chrome/Chromium found (set executablePath)");
        const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
        const languages = opts.languages?.length ? opts.languages : DEFAULT_LANGUAGES;
        const headless = opts.headless || !(await ensureDisplay());

        let proxyServer: string | undefined;
        if (opts.proxy) {
          if (opts.proxy.username || opts.proxy.password) {
            const relay = await startProxyRelay(opts.proxy);
            cleanup.push(() => relay.close());
            proxyServer = relay.server;
          } else proxyServer = opts.proxy.server;
        }

        mkdirSync(opts.userDataDir, { recursive: true });
        const portFile = join(opts.userDataDir, "DevToolsActivePort");
        rmSync(portFile, { force: true });
        const args = [
          `--user-data-dir=${opts.userDataDir}`,
          "--remote-debugging-port=0",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-sync",
          `--lang=${languages[0]}`,
          `--accept-lang=${languages.join(",")}`,
          `--window-size=${viewport.width},${viewport.height}`,
          proxyServer ? `--proxy-server=${proxyServer}` : "--no-proxy-server",
          // Chrome refuses to run as root (Docker) with its sandbox on.
          ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
          ...(headless ? ["--headless=new"] : []),
          // Always on-screen: an off-screen window (screenX -32000) is itself a bot tell Avito acts on.
          ...(opts.userAgent ? [`--user-agent=${opts.userAgent}`] : []),
          opts.startUrl ?? "about:blank",
        ];
        const child: ChildProcess = spawn(executable, args, { stdio: "ignore" });
        cleanup.push(() => void child.kill("SIGTERM"));

        for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
        if (!existsSync(portFile)) throw new Error("clean engine: Chrome did not open its debugging port");
        const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
        const cdp = await RawCdp.connect(`ws://127.0.0.1:${port}${path}`);
        cleanup.push(() => cdp.close());

        // The tab Chrome opened by itself.
        let targetId: string | undefined;
        for (let i = 0; i < 50 && !targetId; i++) {
          const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
          targetId = targetInfos.find((t) => t.type === "page")?.targetId;
          if (!targetId) await sleep(100);
        }
        if (!targetId) throw new Error("clean engine: no page target");
        const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        // Blocking ads/video saves proxy traffic. The Network domain is invisible to the page (unlike Runtime).
        if (opts.blockUrls?.length) {
          await cdp.send("Network.enable", {}, sessionId);
          await cdp.send("Network.setBlockedURLs", { urls: opts.blockUrls }, sessionId);
        }
        return new CleanSession(cdp, sessionId, opts, cleanup);
      } catch (err) {
        for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => undefined);
        throw err;
      }
    },
  };
}

class CleanSession implements BrowserSession {
  private closing: Promise<void> | undefined;

  constructor(
    private readonly cdp: RawCdp,
    private readonly sessionId: string,
    private readonly opts: CleanLaunchOptions,
    private readonly cleanup: (() => Promise<void> | void)[],
  ) {}

  private send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  async evaluate<T = unknown>(js: string): Promise<T> {
    // Runtime.evaluate needs no Runtime.enable: nothing in the page changes when it runs.
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression: js, returnByValue: true, awaitPromise: true },
    );
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "error"}`);
    return r.result.value as T;
  }

  async goto(url: string, opts?: { quick?: boolean }): Promise<void> {
    const before = await this.url().catch(() => "");
    await this.send("Page.navigate", { url });
    const deadline = Date.now() + Math.max(this.opts.actionTimeoutMs ?? 15_000, 30_000);
    let seenNew = false;
    while (Date.now() < deadline) {
      await sleep(250);
      const state = await this.evaluate<{ href: string; ready: string }>("({ href: location.href, ready: document.readyState })").catch(() => null);
      if (!state) continue; // between documents
      if (state.href !== before || url === before) seenNew = true;
      if (seenNew && state.ready !== "loading") {
        // Interactive is enough (heavy pages keep loading ads and trackers forever); give "complete" a few seconds.
        if (!opts?.quick) {
          const soft = Date.now() + 4_000;
          while (Date.now() < soft && (await this.evaluate<string>("document.readyState").catch(() => "")) !== "complete") await sleep(250);
        }
        return;
      }
    }
    throw new Error(`navigation to ${url} did not finish`);
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  html(): Promise<string> {
    return this.evaluate<string>("document.documentElement.outerHTML");
  }

  text(maxChars = 20_000): Promise<string> {
    return this.evaluate<string>(TEXT_JS(maxChars));
  }

  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<PageFetchResult> {
    return this.evaluate<PageFetchResult>(pageFetchJs(url, init));
  }

  act(): Promise<ActResult> {
    return unsupported("act()");
  }

  extract<T>(_instruction: string, _schema: ZodType<T>): Promise<T> {
    return unsupported("extract()");
  }

  observe(): Promise<Observed[]> {
    return unsupported("observe()");
  }

  async exists(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(`!!${RESOLVE_JS}(${JSON.stringify(selector)})`).catch(() => false);
  }

  async click(selector: string): Promise<void> {
    const ok = await this.evaluate<boolean>(`(function(){var el=${RESOLVE_JS}(${JSON.stringify(selector)});if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true})()`);
    if (!ok) throw new Error(`no element for ${selector}`);
  }

  async fill(selector: string, value: string): Promise<void> {
    if (!(await this.evaluate<boolean>(fillJs(selector, value)))) throw new Error(`could not fill ${selector}`);
  }

  upload(): Promise<void> {
    return unsupported("upload()");
  }

  async waitForText(text: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate<boolean>(`(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`).catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  }

  async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.exists(selector)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  }

  async pressKey(key: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key });
  }

  pressEscape(): Promise<void> {
    return this.pressKey("Escape");
  }

  async humanize(_targets: string[], ms: number): Promise<void> {
    // Trusted wheel events (Input domain, no page instrumentation), then idle until ms has passed.
    const end = Date.now() + ms;
    try {
      for (let i = 0; i < 3 && Date.now() < end; i++) {
        await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400 + Math.random() * 300, y: 300 + Math.random() * 200, deltaX: 0, deltaY: 200 + Math.random() * 400 });
        await sleep(300 + Math.random() * 700);
      }
    } catch {
      // best effort
    }
    const left = end - Date.now();
    if (left > 0) await sleep(left);
  }

  async retype(): Promise<boolean> {
    return false;
  }

  async snapshot(name: string): Promise<string> {
    const dir = this.opts.snapshotDir;
    mkdirSync(dir, { recursive: true });
    const base = join(dir, name.replace(/[^a-z0-9._-]/gi, "_"));
    writeFileSync(`${base}.html`, await this.html().catch(() => ""));
    writeFileSync(`${base}.url`, await this.url().catch(() => ""));
    try {
      const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${base}.png`, Buffer.from(data, "base64"));
    } catch {
      // the html snapshot still stands
    }
    return `${base}.html`;
  }

  async cookies(): Promise<Cookie[]> {
    const { cookies } = await this.cdp.send<{ cookies: Cookie[] }>("Storage.getCookies");
    return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, ...(c.sameSite ? { sameSite: c.sameSite } : {}) }));
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    if (cookies.length) await this.cdp.send("Storage.setCookies", { cookies });
  }

  memoryMB(): Promise<number> {
    return chromiumTreeRssMB(this.opts.userDataDir);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await Promise.race([this.cdp.send("Browser.close"), sleep(5_000)]);
      } catch {
        // already gone
      }
      for (const fn of this.cleanup.reverse()) await Promise.resolve(fn()).catch(() => undefined);
      await killChromiumLeftovers(this.opts.userDataDir);
    })();
    return this.closing;
  }
}
