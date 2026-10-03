// Small pure pieces: identity pool, breaker, response classification, JSON extraction, the action cache's heal lock.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionCache } from "../src/browser/cache.js";
import { localeEnv, setPreference } from "../src/browser/clean.js";
import { extractJson } from "../src/llm/json.js";
import { Breaker } from "../src/runtime/health.js";
import { IdentityPool } from "../src/runtime/identity.js";
import { classifyResponse } from "../src/runtime/outcome.js";
import { acceptLanguage, browserHeaders } from "../src/runtime/fingerprint.js";

describe("IdentityPool", () => {
  it("spreads requests by earliest free slot and refuses waits over maxWaitMs", async () => {
    let now = 1_000;
    const pool = new IdentityPool([{ id: "a" }, { id: "b" }], () => now, () => 0.5); // jitter pinned to 1.0x
    const o = { minIntervalMs: 10_000, maxWaitMs: 0 };
    expect((await pool.acquire("wb", o))?.id).toBe("a");
    expect((await pool.acquire("wb", o))?.id).toBe("b");
    expect(await pool.acquire("wb", o)).toBeNull(); // both busy for 10 s
    expect((await pool.acquire("eda", o))?.id).toBe("a"); // other sites have their own slots
    now += 10_000;
    expect((await pool.acquire("wb", o))?.id).toBe("a");
  });

  it("prefers earlier identities while they are free, spilling to later ones", async () => {
    let now = 0;
    const pool = new IdentityPool([{ id: "server" }, { id: "mobile" }], () => now, () => 0.5);
    const o = { minIntervalMs: 1_000, maxWaitMs: 5_000 };
    expect((await pool.acquire("avito", o))?.id).toBe("server");
    expect((await pool.acquire("avito", o))?.id).toBe("mobile"); // server busy for 1 s
    now = 1_000;
    expect((await pool.acquire("avito", o))?.id).toBe("server"); // free again: back to the primary
    pool.report("avito", "server", "banned", 60_000);
    now = 3_000;
    expect((await pool.acquire("avito", o))?.id).toBe("mobile"); // primary quarantined
  });

  it("restricts proxy-only sites to proxy identities", async () => {
    const pool = new IdentityPool([{ id: "direct" }, { id: "mobile", proxy: { server: "http://p:1" } }], () => 0);
    expect((await pool.acquire("avito", { minIntervalMs: 0, maxWaitMs: 0, proxyOnly: true }))?.id).toBe("mobile");
    expect(await pool.acquire("avito", { minIntervalMs: 0, maxWaitMs: 0, proxyOnly: true, exclude: new Set(["mobile"]) })).toBeNull();
  });

  it("quarantines per site with doubling cooldowns", async () => {
    let now = 0;
    const pool = new IdentityPool([{ id: "a" }], () => now);
    const o = { minIntervalMs: 0, maxWaitMs: 0 };
    pool.report("wb", "a", "banned", 1_000);
    expect(await pool.acquire("wb", o)).toBeNull();
    expect(pool.allQuarantined("wb")).toBe(true);
    expect(await pool.acquire("eda", o)).not.toBeNull();
    now = 1_000;
    expect(await pool.acquire("wb", o)).not.toBeNull();
    pool.report("wb", "a", "banned", 1_000); // second ban in a row: 2 s
    now = 2_500;
    expect(await pool.acquire("wb", o)).toBeNull();
    now = 3_000;
    pool.report("wb", "a", "ok", 1_000);
    expect(await pool.acquire("wb", o)).not.toBeNull();
  });
});

describe("IdentityPool jitter", () => {
  it("spreads intervals ±30% around the configured pace", async () => {
    let r = 0;
    const pool = new IdentityPool([{ id: "a" }], () => 0, () => r);
    await pool.acquire("s", { minIntervalMs: 1_000, maxWaitMs: 0 });
    r = 1;
    expect(await pool.acquire("s", { minIntervalMs: 1_000, maxWaitMs: 699 })).toBeNull(); // slot at 700 ms
    expect(await pool.acquire("s", { minIntervalMs: 1_000, maxWaitMs: 2_000 })).not.toBeNull();
  });
});

describe("browserHeaders", () => {
  const site = { id: "wb", origin: "https://www.wildberries.ru", endpoints: {} };
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
  it("matches client hints to the user agent and sets fetch metadata like Chrome", () => {
    const h = browserHeaders({ id: "x", userAgent: ua }, site, new URL("https://www.wildberries.ru/__internal/search"), "GET");
    expect(h["sec-ch-ua"]).toContain('"Google Chrome";v="153"');
    expect(h["sec-ch-ua-platform"]).toBe('"macOS"');
    expect(h["sec-ch-ua-mobile"]).toBe("?0");
    expect(h["sec-fetch-site"]).toBe("same-origin");
    expect(h.referer).toBe("https://www.wildberries.ru/");
    expect(h.origin).toBeUndefined(); // same-origin GET: Chrome sends none
  });
  it("marks sibling subdomains same-site and adds Origin off-origin or on POST", () => {
    const sub = browserHeaders({ id: "x", userAgent: ua }, site, new URL("https://basket-01.wildberries.ru/x"), "GET");
    expect(sub["sec-fetch-site"]).toBe("same-site");
    expect(sub.origin).toBe("https://www.wildberries.ru");
    const post = browserHeaders({ id: "x", userAgent: ua }, site, new URL("https://www.wildberries.ru/x"), "POST");
    expect(post.origin).toBe("https://www.wildberries.ru");
    expect(browserHeaders({ id: "x", userAgent: ua }, site, new URL("https://cdn.other.ru/x"), "GET")["sec-fetch-site"]).toBe("cross-site");
  });
  it("writes Accept-Language with Chrome's q weights", () => {
    expect(acceptLanguage(["ru-RU", "ru", "en-US", "en"])).toBe("ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7");
  });
});

describe("Breaker", () => {
  it("opens at the threshold and allows a trial after the cooldown", () => {
    let now = 0;
    const b = new Breaker({ threshold: 2, cooldownMs: 100 }, () => now);
    b.failure("k");
    expect(b.allow("k")).toBe(true);
    b.failure("k");
    expect(b.allow("k")).toBe(false);
    now = 100;
    expect(b.allow("k")).toBe(true);
    b.failure("k"); // trial failed: open again at once
    expect(b.allow("k")).toBe(false);
    b.success("k");
    expect(b.allow("k")).toBe(true);
  });
});

describe("classifyResponse", () => {
  const r = (status: number, body = "", url = "https://x.ru/api") => ({ status, body, url, contentType: "" });
  it("maps statuses to outcomes", () => {
    expect(classifyResponse(r(200))).toBeNull();
    expect(classifyResponse(r(498))?.outcome).toBe("banned");
    expect(classifyResponse(r(429))?.outcome).toBe("banned");
    expect(classifyResponse(r(404))?.outcome).toBe("changed");
    expect(classifyResponse(r(502))?.outcome).toBe("error");
    expect(classifyResponse(r(503, "<html>ddos-guard</html>"))?.outcome).toBe("banned");
  });
});

describe("extractJson", () => {
  it("finds JSON in fences and prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure:\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('here it is {"b":"}"} done')).toEqual({ b: "}" });
    expect(() => extractJson("nothing")).toThrow();
  });
});

describe("ActionCache.heal", () => {
  it("runs one heal per step; concurrent callers wait for it", async () => {
    const cache = new ActionCache();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const heal = () =>
      cache.heal("shop.ru", "search.submit", async () => {
        runs++;
        await gate;
        cache.success("shop.ru", "search.submit", { selector: "//button", method: "click", arguments: [], description: "Find" });
        return "healed";
      });
    const first = heal();
    const second = heal();
    release();
    expect(await first).toEqual({ ran: true, value: "healed" });
    expect(await second).toEqual({ ran: false });
    expect(runs).toBe(1);
    expect(cache.get("shop.ru", "search.submit")?.selector).toBe("//button");
  });
});

describe("clean engine profile + env", () => {
  it("maps a BCP 47 tag to LANG/LANGUAGE", () => {
    expect(localeEnv("ru-RU")).toEqual({ LANG: "ru_RU.UTF-8", LANGUAGE: "ru_RU:ru" });
    expect(localeEnv("en")).toEqual({ LANG: "en.UTF-8", LANGUAGE: "en" });
    expect(localeEnv("")).toEqual({});
  });

  it("sets one preference and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "webtap-prefs-"));
    setPreference(dir, ["webrtc", "ip_handling_policy"], "disable_non_proxied_udp");
    const file = join(dir, "Default", "Preferences");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ webrtc: { ip_handling_policy: "disable_non_proxied_udp" } });
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(file, JSON.stringify({ profile: { name: "x" }, webrtc: { other: 1 } }));
    setPreference(dir, ["webrtc", "ip_handling_policy"], "disable_non_proxied_udp");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ profile: { name: "x" }, webrtc: { other: 1, ip_handling_policy: "disable_non_proxied_udp" } });
  });
});
