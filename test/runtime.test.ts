// Runtime behaviour with fake strategies and a local HTTP server: fallback, bans → identity rotation, breaker,
// validation, canaries, health, the HTTP front.
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  banned,
  changed,
  createServer,
  createWebtap,
  defineSite,
  endpoint,
  http,
  WebtapError,
  type BrowserLauncher,
  type Strategy,
} from "../src/index.js";

const noBrowser: BrowserLauncher = { launch: () => Promise.reject(new Error("no browser in tests")) };

type In = { q: string };
type Out = { items: string[] };
const fake = (name: string, run: (identity: string, input: In) => Out | Promise<Out>): Strategy<In, Out> => ({
  kind: "http",
  name,
  run: async (ctx, input) => run(ctx.identity.id, input),
});

const siteWith = (strategies: Strategy<In, Out>[], extra: { verify?: (o: Out) => string | null } = {}) =>
  defineSite({
    id: "shop",
    origin: "https://shop.example",
    rateLimit: { minIntervalMs: 0 },
    endpoints: {
      search: endpoint(
        { input: z.object({ q: z.string().min(1) }), output: z.object({ items: z.array(z.string()) }) },
        { strategies, canary: { input: { q: "roses" } }, ...extra },
      ),
    },
  });

describe("fallback and outcomes", () => {
  it("falls through a changed strategy to the next one and reports degraded health", async () => {
    const wt = createWebtap({
      launcher: noBrowser,
      sites: [
        siteWith([
          fake("api", () => {
            throw changed("404");
          }),
          fake("page", (_, i) => ({ items: [i.q] })),
        ]),
      ],
    });
    const r = await wt.call<Out>("shop", "search", { q: "roses" });
    expect(r.data.items).toEqual(["roses"]);
    expect(r.strategy).toBe("page");
    expect(r.attempts.map((a) => `${a.strategy}:${a.outcome}`)).toEqual(["api:changed", "page:ok"]);
    const h = wt.health().sites.shop!.search!;
    expect(h.status).toBe("degraded");
    expect(h.strategies.api!.changed).toBe(1);
    await wt.close();
  });

  it("quarantines a banned identity and retries the same strategy on another one", async () => {
    const wt = createWebtap({
      launcher: noBrowser,
      identities: [{ id: "a" }, { id: "b" }],
      sites: [
        siteWith([
          fake("api", (identity) => {
            if (identity === "a") throw banned("HTTP 498");
            return { items: ["ok"] };
          }),
        ]),
      ],
    });
    const r = await wt.call("shop", "search", { q: "x" });
    expect(r.identity).toBe("b");
    expect(r.attempts.map((a) => `${a.identity}:${a.outcome}`)).toEqual(["a:banned", "b:ok"]);
    // a stays benched for this site: the next call goes straight to b
    const r2 = await wt.call("shop", "search", { q: "y" });
    expect(r2.attempts.map((a) => a.identity)).toEqual(["b"]);
    const a = wt.health().identities.find((s) => s.identity === "a" && s.site === "shop");
    expect(a?.state).toBe("quarantined");
    await wt.close();
  });

  it("retries a transient error once on the same identity when it is the only one", async () => {
    let runs = 0;
    const wt = createWebtap({
      launcher: noBrowser,
      sites: [
        siteWith([
          fake("api", () => {
            if (++runs === 1) throw new Error("socket hang up");
            return { items: ["ok"] };
          }),
        ]),
      ],
    });
    const r = await wt.call("shop", "search", { q: "x" });
    expect(r.attempts.map((a) => `${a.identity}:${a.outcome}`)).toEqual(["direct:error", "direct:ok"]);
    await wt.close();
  });

  it("does not retry a ban on the same identity", async () => {
    let runs = 0;
    const wt = createWebtap({ launcher: noBrowser, sites: [siteWith([fake("api", () => ((runs++, Promise.reject(banned("498")))))])] });
    await wt.call("shop", "search", { q: "x" }).catch(() => undefined);
    expect(runs).toBe(1);
    await wt.close();
  });

  it("rotates a proxy's IP on a ban and retries after a short pause instead of a long quarantine", async () => {
    let rotations = 0;
    const rot = createHttpServer((_req, res) => {
      rotations++;
      res.end('{"status":"OK"}');
    });
    await new Promise<void>((r) => rot.listen(0, "127.0.0.1", r));
    const rotateUrl = `http://127.0.0.1:${(rot.address() as AddressInfo).port}/change`;
    const wt = createWebtap({
      launcher: noBrowser,
      identities: [{ id: "mobile", proxy: { server: "http://127.0.0.1:1" }, rotateUrl }],
      sites: [siteWith([fake("api", () => Promise.reject(banned("429")))])],
    });
    try {
      await wt.call("shop", "search", { q: "x" }).catch(() => undefined);
      expect(rotations).toBe(1);
      const st = wt.health().identities.find((s) => s.identity === "mobile");
      expect(st?.quarantinedForMs).toBeLessThanOrEqual(15_000);
    } finally {
      await wt.close();
      rot.close();
    }
  }, 20_000);

  it("fails with every attempt listed when all identities are banned", async () => {
    const wt = createWebtap({
      launcher: noBrowser,
      identities: [{ id: "a" }, { id: "b" }],
      sites: [siteWith([fake("api", () => Promise.reject(banned("captcha")))])],
    });
    const err = await wt.call("shop", "search", { q: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebtapError);
    expect((err as WebtapError).code).toBe("failed");
    expect((err as WebtapError).attempts.map((a) => a.outcome)).toEqual(["banned", "banned", "skipped"]);
    expect(wt.health().sites.shop!.search!.status).toBe("down");
    await wt.close();
  });

  it("opens the breaker after repeated changed failures and skips that strategy", async () => {
    let apiRuns = 0;
    const wt = createWebtap({
      launcher: noBrowser,
      breaker: { threshold: 2, cooldownMs: 60_000 },
      sites: [
        siteWith([
          fake("api", () => {
            apiRuns++;
            throw changed("shape");
          }),
          fake("page", () => ({ items: ["x"] })),
        ]),
      ],
    });
    for (let i = 0; i < 4; i++) await wt.call("shop", "search", { q: "x" });
    expect(apiRuns).toBe(2);
    expect(wt.health().sites.shop!.search!.strategies.api!.breakerOpen).toBe(true);
    // forcing the strategy bypasses the breaker (that is how a canary re-tests it)
    await wt.call("shop", "search", { q: "x" }, { strategy: "api" }).catch(() => undefined);
    expect(apiRuns).toBe(3);
    await wt.close();
  });

  it("treats output that fails the schema or verify as changed", async () => {
    const wt = createWebtap({
      launcher: noBrowser,
      sites: [
        siteWith([fake("bad-shape", () => ({ items: [1] }) as unknown as Out), fake("empty", () => ({ items: [] }))], {
          verify: (o: Out) => (o.items.length ? null : "no items"),
        }),
      ],
    });
    const err = (await wt.call("shop", "search", { q: "x" }).catch((e: unknown) => e)) as WebtapError;
    expect(err.attempts.map((a) => a.outcome)).toEqual(["changed", "changed"]);
    expect(err.attempts[1]!.message).toContain("verify: no items");
    await wt.close();
  });

  it("rejects bad input before running anything", async () => {
    let ran = false;
    const wt = createWebtap({ launcher: noBrowser, sites: [siteWith([fake("api", () => ((ran = true), { items: [] }))])] });
    const err = (await wt.call("shop", "search", { q: "" }).catch((e: unknown) => e)) as WebtapError;
    expect(err.code).toBe("bad_input");
    expect(ran).toBe(false);
    await expect(wt.call("nope", "search", {})).rejects.toMatchObject({ code: "unknown_site" });
    await wt.close();
  });

  it("runs canaries with the default non-empty check", async () => {
    let items: string[] = ["a"];
    const wt = createWebtap({ launcher: noBrowser, sites: [siteWith([fake("api", () => ({ items }))])] });
    expect((await wt.runCanaries())["shop/search"]?.ok).toBe(true);
    items = [];
    const r = (await wt.runCanaries())["shop/search"];
    expect(r?.ok).toBe(false);
    expect(r?.message).toBe("empty result");
    expect(wt.health().sites.shop!.search!.canary?.ok).toBe(false);
    await wt.close();
  });

  it("describes endpoints with JSON Schemas", async () => {
    const wt = createWebtap({ launcher: noBrowser, sites: [siteWith([fake("api", () => ({ items: [] }))])] });
    const [info] = wt.describe();
    expect(info).toMatchObject({ site: "shop", endpoint: "search", strategies: [{ name: "api", kind: "http" }] });
    expect((info!.input as { properties: object }).properties).toHaveProperty("q");
    await wt.close();
  });
});

describe("http strategy against a real server", () => {
  let server: Server;
  let origin = "";
  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/api/search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ products: [{ name: `${url.searchParams.get("q")} bouquet`, ua: req.headers["user-agent"] }] }));
      } else if (url.pathname === "/blocked") {
        res.writeHead(498, { "content-type": "text/html" });
        res.end("<script src='/__wbaas/challenges/antibot/x.js'></script>");
      } else if (url.pathname === "/challenge200") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>please solve the captcha</html>");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const site = (path: string) =>
    defineSite({
      id: "flowers",
      origin,
      rateLimit: { minIntervalMs: 0 },
      endpoints: {
        search: endpoint(
          { input: z.object({ q: z.string() }), output: z.object({ items: z.array(z.object({ title: z.string() })) }) },
          {
            strategies: [
              http({
                request: (i) => ({ url: `${path}?q=${encodeURIComponent(i.q)}`, headers: { "user-agent": "webtap-test" } }),
                parse: (json: { products: { name: string }[] }) => ({ items: json.products.map((p) => ({ title: p.name })) }),
              }),
            ],
          },
        ),
      },
    });

  it("fetches and maps JSON", async () => {
    const wt = createWebtap({ launcher: noBrowser, sites: [site("/api/search")] });
    const r = await wt.call<{ items: { title: string }[] }>("flowers", "search", { q: "roses" });
    expect(r.data.items).toEqual([{ title: "roses bouquet" }]);
    await wt.close();
  });

  it("classifies a challenge status as banned, a 200 challenge page as banned, a 404 as changed", async () => {
    for (const [path, outcome] of [
      ["/blocked", "banned"],
      ["/challenge200", "banned"],
      ["/gone", "changed"],
    ] as const) {
      const wt = createWebtap({ launcher: noBrowser, sites: [site(path)] });
      const err = (await wt.call("flowers", "search", { q: "x" }).catch((e: unknown) => e)) as WebtapError;
      expect(err.attempts[0]?.outcome, path).toBe(outcome);
      await wt.close();
    }
  });

  it("serves endpoints over HTTP with auth", async () => {
    const wt = createWebtap({ launcher: noBrowser, sites: [site("/api/search")] });
    const srv = createServer(wt, { token: "secret" });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(401);
      const auth = { authorization: "Bearer secret", "content-type": "application/json" };
      const ok = await fetch(`${base}/sites/flowers/search`, { method: "POST", headers: auth, body: JSON.stringify({ q: "tulips" }) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ data: { items: [{ title: "tulips bouquet" }] }, meta: { strategy: "http" } });
      const bad = await fetch(`${base}/sites/flowers/search`, { method: "POST", headers: auth, body: JSON.stringify({}) });
      expect(bad.status).toBe(400);
      const catalog = (await (await fetch(`${base}/sites`, { headers: auth })).json()) as unknown[];
      expect(catalog).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      await wt.close();
    }
  });
});
