// The remote-browser plumbing: DevTools endpoint resolution, tab ownership, wipe origins, and which sessions the pool
// sends to a remote browser.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawCdp } from "../src/browser/cdp.js";
import { browserWsUrl, cookieOrigins, openRemoteTab, rewriteWsHost } from "../src/browser/remote.js";
import { browser, createWebtap, defineSite, endpoint, z, type BrowserLauncher, type BrowserOptions, type BrowserSession } from "../src/index.js";

describe("browserWsUrl", () => {
  let server: Server;
  let base = "";
  const hosts: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hosts.push(req.headers.host ?? "");
      // Chrome writes back the Host it was asked with; a relay in front of it may report its own port.
      res.end(JSON.stringify({ Browser: "Chrome/146", webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/abc" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("points the browser websocket at the address it reached /json/version on", async () => {
    expect(await browserWsUrl(base)).toBe(`${base.replace("http", "ws")}/devtools/browser/abc`);
    expect(hosts.at(-1)).toBe(base.slice("http://".length));
  });

  it("asks a host name by its address (Chrome only answers an IP or localhost Host)", async () => {
    const port = (server.address() as AddressInfo).port;
    await browserWsUrl(`http://localhost:${port}`);
    expect(hosts.at(-1)).toBe(`localhost:${port}`);
  });

  it("takes a ws url as is", async () => {
    expect(await browserWsUrl("ws://10.0.0.2:9222/devtools/browser/x")).toBe("ws://10.0.0.2:9222/devtools/browser/x");
  });

  it("rewrites only the host of the websocket url", () => {
    expect(rewriteWsHost("ws://localhost:9223/devtools/browser/abc?x=1", "172.20.0.3:9222")).toBe("ws://172.20.0.3:9222/devtools/browser/abc?x=1");
    expect(rewriteWsHost("ws://localhost/devtools/browser/abc", "cdp.example:443", true)).toBe("wss://cdp.example:443/devtools/browser/abc");
  });
});

describe("openRemoteTab", () => {
  /** A browser with pages: createTarget adds one, closeTarget removes it. */
  const fakeBrowser = (pages: string[]) => {
    let n = 0;
    const closed: string[] = [];
    const cdp = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === "Target.createTarget") {
          const id = `new${++n}`;
          pages.push(id);
          return { targetId: id };
        }
        if (method === "Target.getTargets") return { targetInfos: [...pages.map((id) => ({ type: "page", targetId: id, url: "" })), { type: "service_worker", targetId: "sw", url: "" }] };
        if (method === "Target.closeTarget") {
          closed.push(String(params.targetId));
          pages.splice(pages.indexOf(String(params.targetId)), 1);
          return {};
        }
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as RawCdp;
    return { cdp, pages, closed };
  };

  it("opens a fresh tab and closes leftovers, but never a live session's tab", async () => {
    const b = fakeBrowser(["stale1", "stale2"]);
    const first = await openRemoteTab(b.cdp, "http://b1:9222");
    expect(b.closed).toEqual(["stale1", "stale2"]);
    const second = await openRemoteTab(b.cdp, "http://b1:9222");
    expect(b.pages).toEqual([first.targetId, second.targetId]);
    // The first session is dropped: its tab becomes a leftover the next session replaces.
    first.release();
    const third = await openRemoteTab(b.cdp, "http://b1:9222");
    expect(b.pages).toEqual([second.targetId, third.targetId]);
    second.release();
    third.release();
  });
});

describe("cookieOrigins", () => {
  it("gives each cookie domain over https and http, once", () => {
    expect(cookieOrigins([{ domain: ".avito.ru" }, { domain: "www.avito.ru" }, { domain: "avito.ru" }])).toEqual([
      "https://avito.ru",
      "http://avito.ru",
      "https://www.avito.ru",
      "http://www.avito.ru",
    ]);
  });
});

describe("the pool and remote identities", () => {
  const remote = { cdpUrl: "http://stealth-browser:9222", nativePersona: true };
  const recorder = () => {
    const seen: BrowserOptions[] = [];
    const launcher: BrowserLauncher = {
      launch: async (o) => {
        seen.push(o);
        return { url: async () => "about:blank", close: async () => undefined } as unknown as BrowserSession;
      },
    };
    return { seen, launcher };
  };
  const site = (id: string, engine: "clean" | "stagehand") =>
    defineSite({
      id,
      origin: `https://${id}.example`,
      rateLimit: { minIntervalMs: 0 },
      browser: { engine },
      endpoints: {
        get: endpoint(
          { input: z.object({}), output: z.object({ ok: z.boolean() }) },
          { strategies: [browser({ run: async () => ({ ok: true }) })] },
        ),
      },
    });

  it("hands a clean site's session to the remote browser, and a Stagehand site its own Chrome", async () => {
    const clean = recorder();
    const stagehand = recorder();
    const wt = createWebtap({
      sites: [site("shop", "clean"), site("blog", "stagehand")],
      identities: [{ id: "phone", remote, os: "windows" }],
      launcher: stagehand.launcher,
      cleanLauncher: clean.launcher,
    });
    await wt.call("shop", "get", {});
    await wt.call("blog", "get", {});
    expect(clean.seen[0]?.remote).toEqual(remote);
    expect(stagehand.seen[0]?.remote).toBeUndefined();
    await wt.close();
  });
});
