// Session keys (seal / open / describe), the cookie filter, and export/import through the runtime with a fake browser.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer, createWebtap, decodeSessionKey, defineSite, describeSession, encodeSessionKey, endpoint, http, siteCookies, type BrowserLauncher, type BrowserSession, type Cookie, type SessionBundle } from "../src/index.js";

const cookie = (domain: string, name = "sid", expires = 4_000_000_000): Cookie => ({ name, value: `v-${name}`, domain, path: "/", expires, httpOnly: true, secure: true });
const bundle: SessionBundle = { v: 1, site: "shop", identity: "home", createdAt: "2026-10-23T10:00:00.000Z", cookies: [cookie(".shop.example"), cookie("www.shop.example", "csrf", 0)] };

describe("session key", () => {
  it("round-trips and never shows a cookie value in the clear", () => {
    const key = encodeSessionKey(bundle, "s3cret");
    expect(key.startsWith("wts1.")).toBe(true);
    expect(key).not.toContain("v-sid");
    expect(decodeSessionKey(key, "s3cret")).toEqual(bundle);
    expect(encodeSessionKey(bundle, "s3cret")).not.toBe(key); // fresh salt + iv each time
  });

  it("refuses a wrong secret, a flipped bit, a truncated key and a foreign string", () => {
    const key = encodeSessionKey(bundle, "s3cret");
    expect(() => decodeSessionKey(key, "other")).toThrow(/wrong secret/);
    const flipped = key.slice(0, -3) + (key.endsWith("AAA") ? "BBB" : "AAA");
    expect(() => decodeSessionKey(flipped, "s3cret")).toThrow(/wrong secret|altered/);
    expect(() => decodeSessionKey("wts1.abc", "s3cret")).toThrow(/truncated/);
    expect(() => decodeSessionKey("hello", "s3cret")).toThrow(/not a session key/);
    expect(() => encodeSessionKey(bundle, "")).toThrow(/secret/);
  });

  it("describes a bundle without its values", () => {
    const d = describeSession(bundle, Date.UTC(2026, 9, 23));
    expect(d).toEqual({ site: "shop", cookies: 2, domains: [".shop.example", "www.shop.example"], expiresAt: new Date(4_000_000_000_000).toISOString(), expired: false });
    expect(describeSession({ ...bundle, cookies: [cookie(".shop.example", "old", 1_000)] }, Date.UTC(2026, 9, 23)).expired).toBe(true);
    expect(JSON.stringify(d)).not.toContain("v-sid");
  });
});

describe("siteCookies", () => {
  const all = [cookie(".shop.example"), cookie("auth.shop.example"), cookie(".other.example"), cookie("evilshop.example")];
  it("keeps the origin's parent domain and its subdomains only", () => {
    expect(siteCookies(all, "https://www.shop.example").map((c) => c.domain)).toEqual([".shop.example", "auth.shop.example"]);
  });
  it("takes explicit domains over the guess", () => {
    expect(siteCookies(all, "https://www.shop.example", ["other.example"]).map((c) => c.domain)).toEqual([".other.example"]);
  });
});

// A browser that is only a cookie jar.
const jar = (stored: Cookie[]): BrowserLauncher => {
  const session = {
    cookies: async () => stored,
    setCookies: async (c: Cookie[]) => void stored.push(...c),
    close: async () => undefined,
  } as unknown as BrowserSession;
  return { launch: async () => session };
};

const shop = defineSite({
  id: "shop",
  origin: "https://www.shop.example",
  endpoints: { ping: endpoint({ input: z.object({}), output: z.object({}) }, { strategies: [http({ request: () => ({ url: "/" }), parse: () => ({}) })] }) },
});

describe("exportSession / importSession", () => {
  it("exports the site's cookies after the person is done, and imports them elsewhere", async () => {
    const browserA: Cookie[] = [cookie(".shop.example"), cookie(".unrelated.example", "x")];
    const a = createWebtap({ launcher: jar(browserA), cleanLauncher: jar(browserA), sites: [shop], identities: [{ id: "home" }] });
    let waited = false;
    const exported = await a.exportSession("shop", { whileOpen: async () => void (waited = true) });
    await a.close();
    expect(waited).toBe(true);
    expect(exported).toMatchObject({ v: 1, site: "shop", identity: "home" });
    expect(exported.cookies.map((c) => c.domain)).toEqual([".shop.example"]); // the unrelated cookie stays home

    const browserB: Cookie[] = [];
    const b = createWebtap({ launcher: jar(browserB), cleanLauncher: jar(browserB), sites: [shop], identities: [{ id: "server" }] });
    expect(await b.importSession("shop", exported)).toEqual({ cookies: 1 });
    expect(browserB).toEqual(exported.cookies);
    await expect(b.importSession("other", exported)).rejects.toThrow(/unknown site/);
    await expect(b.importSession("shop", { ...exported, site: "x" })).rejects.toThrow(/is for x/);
    await b.close();
  });

  it("refuses to export when the browser holds nothing for the site", async () => {
    const empty: Cookie[] = [cookie(".unrelated.example")];
    const w = createWebtap({ launcher: jar(empty), cleanLauncher: jar(empty), sites: [shop] });
    await expect(w.exportSession("shop", { whileOpen: async () => undefined })).rejects.toThrow(/nothing to export/);
    await w.close();
  });

  it("PUT /sessions/:site signs the site in from a key, and only with a secret configured", async () => {
    const stored: Cookie[] = [];
    const w = createWebtap({ launcher: jar(stored), cleanLauncher: jar(stored), sites: [shop] });
    const key = encodeSessionKey({ ...bundle, cookies: [cookie(".shop.example")] }, "s3cret");
    const listen = async (secret?: string) => {
      const srv = createServer(w, secret ? { sessionSecret: secret } : {});
      await new Promise<void>((r) => srv.listen(0, r));
      const port = (srv.address() as { port: number }).port;
      return { srv, put: (k: string) => fetch(`http://127.0.0.1:${port}/sessions/shop`, { method: "PUT", body: JSON.stringify({ key: k }) }) };
    };
    const open = await listen("s3cret");
    const ok = await open.put(key);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ site: "shop", cookies: 1 });
    expect(stored).toHaveLength(1);
    expect((await open.put("wts1.garbage-garbage-garbage-garbage-garbage-garbage-garbage")).status).toBe(400);
    open.srv.close();
    const off = await listen();
    expect((await off.put(key)).status).toBe(404);
    off.srv.close();
    await w.close();
  });
});
