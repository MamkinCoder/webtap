// Small pure pieces: identity pool, breaker, response classification, JSON extraction, the action cache's heal lock.
import { describe, expect, it } from "vitest";
import { ActionCache } from "../src/browser/cache.js";
import { extractJson } from "../src/llm/json.js";
import { Breaker } from "../src/runtime/health.js";
import { IdentityPool } from "../src/runtime/identity.js";
import { classifyResponse } from "../src/runtime/outcome.js";

describe("IdentityPool", () => {
  it("spreads requests by earliest free slot and refuses waits over maxWaitMs", async () => {
    let now = 1_000;
    const pool = new IdentityPool([{ id: "a" }, { id: "b" }], () => now);
    const o = { minIntervalMs: 10_000, maxWaitMs: 0 };
    expect((await pool.acquire("wb", o))?.id).toBe("a");
    expect((await pool.acquire("wb", o))?.id).toBe("b");
    expect(await pool.acquire("wb", o)).toBeNull(); // both busy for 10 s
    expect((await pool.acquire("eda", o))?.id).toBe("a"); // other sites have their own slots
    now += 10_000;
    expect((await pool.acquire("wb", o))?.id).toBe("a");
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
