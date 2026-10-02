// Mapper pieces without a browser: candidate ranking, input templating, field specs, parse codegen + validation,
// and rendering a site file that compiles.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RecordedExchange } from "../src/browser/cdp.js";
import { fillTemplate, keepHeaders, rankCandidates, toTemplate, traceChain, truthStrings } from "../src/mapper/analyze.js";
import { annotateAny, compileChain, generateParse, parseFields, renderSite } from "../src/mapper/codegen.js";
import type { WebtapLLM } from "../src/types.js";

const ex = (over: Partial<RecordedExchange>): RecordedExchange => ({
  url: "https://shop.example/api",
  method: "GET",
  type: "XHR",
  requestHeaders: {},
  status: 200,
  mimeType: "application/json",
  body: "{}",
  startedAt: 0,
  finishedAt: 0,
  ...over,
});

const hotels = {
  data: {
    hotels: [
      { name: "Гранд Отель Жемчужина", price: { amount: 1250000 }, rating: 8.9, slug: "zhemchuzhina" },
      { name: "Radisson Rosa Khutor", price: { amount: 2100000 }, rating: 9.1, slug: "radisson" },
    ],
  },
};

describe("rankCandidates", () => {
  it("picks the JSON response that contains what the page showed", () => {
    const truths = truthStrings([{ title: "Гранд Отель Жемчужина", price: "12 500 ₽" }, { title: "Radisson Rosa Khutor" }]);
    const ranked = rankCandidates(
      [
        ex({ url: "https://x/analytics", body: '{"ok":true}' }),
        ex({ url: "https://x/html", body: "<html>Гранд Отель Жемчужина</html>", mimeType: "text/html" }),
        ex({ url: "https://x/search", body: JSON.stringify(hotels).replace("Гранд", "\\u0413\\u0440\\u0430\\u043d\\u0434") }),
        ex({ url: "https://x/failed", status: 500, body: JSON.stringify(hotels) }),
      ],
      truths,
    );
    expect(ranked.map((c) => c.exchange.url)).toEqual(["https://x/search"]);
    expect(ranked[0]!.score).toBe(2);
  });
});

describe("toTemplate / fillTemplate", () => {
  it("parameterises sample inputs in the url and a JSON body, and drops browser-managed headers", () => {
    const t = toTemplate(
      ex({
        url: "https://travel.example/api/search?city=%D0%A1%D0%BE%D1%87%D0%B8&from=2026-10-16&n=2",
        method: "POST",
        postData: JSON.stringify({ geo: { lat: 55.75 }, q: "Сочи", nights: 2 }),
        requestHeaders: { "user-agent": "x", cookie: "a=b", "x-device": "d1", "content-type": "application/json", "sec-ch-ua": "y" },
      }),
      { city: "Сочи", checkIn: "2026-10-16", lat: 55.75 },
    );
    expect(t.usedInputs.sort()).toEqual(["checkIn", "city", "lat"]);
    expect(t.headers).toEqual({ "x-device": "d1" });
    const filled = fillTemplate(t, { city: "Казань", checkIn: "2026-11-01", lat: 55.79 });
    expect(filled.url).toBe("https://travel.example/api/search?city=%D0%9A%D0%B0%D0%B7%D0%B0%D0%BD%D1%8C&from=2026-11-01&n=2");
    expect(filled.body).toEqual({ geo: { lat: 55.79 }, q: "Казань", nights: 2 });
  });

  it("keeps custom headers like deviceid", () => {
    expect(keepHeaders({ deviceid: "site_1", "x-requested-with": "XMLHttpRequest", "accept-encoding": "gzip", ":path": "/" })).toEqual({
      deviceid: "site_1",
      "x-requested-with": "XMLHttpRequest",
    });
  });
});

describe("traceChain", () => {
  it("follows ids back through earlier calls to the one that carries the input, skipping later and repeating calls", () => {
    const suggest = ex({ url: "https://s.example/api/suggest?query=%D0%A1%D0%BE%D1%87%D0%B8", body: JSON.stringify({ data: [{ location: { id: 287390 } }] }), startedAt: 1, finishedAt: 2 });
    const places = ex({ url: "https://s.example/api/places?cityId=287390", body: JSON.stringify({ city_id: 287390 }), startedAt: 3, finishedAt: 4 });
    const search = ex({ url: "https://s.example/api/search?location_id=287390&from=2026-10-16", body: JSON.stringify({ objects: [{ id: 760857 }, { id: 1357913 }] }), startedAt: 5, finishedAt: 6 });
    const details = ex({ url: "https://s.example/api/details?ids[]=760857&ids[]=1357913&from=2026-10-16", body: "{}", startedAt: 7, finishedAt: 8 });
    const reviews = ex({ url: "https://s.example/api/reviews", body: JSON.stringify({ objects: [{ object_id: 760857 }] }), startedAt: 7, finishedAt: 7.5 }); // after details was sent
    const c = traceChain(details, [suggest, places, search, reviews, details], { city: "Сочи", from: "2026-10-16" });
    expect(c.exchanges.map((e) => new URL(e.url).pathname)).toEqual(["/api/suggest", "/api/search", "/api/details"]);
    expect(c.reachesInputs).toBe(true);
    expect(c.links).toContainEqual({ value: "287390", from: 0, path: "data[0].location.id", to: 1 });
    expect(c.links).toContainEqual({ value: "760857", from: 1, path: "objects[0].id", to: 2 });
  });
});

describe("parseFields", () => {
  it("reads name[:type][?]", () => {
    expect(parseFields("title, priceRub:number?, url")).toEqual([
      { name: "title", type: "string", optional: false },
      { name: "priceRub", type: "number", optional: true },
      { name: "url", type: "string", optional: false },
    ]);
    expect(() => parseFields("bad field")).toThrow();
  });
});

describe("generateParse", () => {
  const fields = parseFields("title,priceRub:number?,url");
  const gen = (replies: string[]) => {
    const prompts: string[] = [];
    const llm: WebtapLLM = {
      generate: async (p) => {
        prompts.push(p.messages.at(-1)!.content);
        return { text: replies.shift() ?? "" };
      },
    };
    return { llm, prompts };
  };

  it("feeds a failure back and accepts the fixed function", async () => {
    const { llm, prompts } = gen([
      "(json) => ({ items: json.data.hotels.map(h => ({ title: h.name })) })", // no url: schema fails
      "```js\n(json) => ({ items: json.data.hotels.map(h => ({ title: h.name, priceRub: h.price.amount / 100, url: 'https://x.ru/hotel/' + h.slug })) })\n```",
    ]);
    const r = await generateParse(llm, { goal: "hotels", origin: "https://x.ru", fields, json: hotels, truth: [{ title: "Radisson Rosa Khutor" }], input: {} });
    expect(r.items[0]).toEqual({ title: "Гранд Отель Жемчужина", priceRub: 12500, url: "https://x.ru/hotel/zhemchuzhina" });
    expect(r.truthMatched).toBe(1);
    expect(prompts[1]).toContain("That failed");
  });

  it("rejects output that does not reproduce the page", async () => {
    const wrong = "(json) => ({ items: [{ title: 'something else', url: 'u' }] })";
    const { llm } = gen([wrong, wrong]);
    await expect(
      generateParse(llm, { goal: "hotels", origin: "https://x.ru", fields, json: hotels, truth: [{ title: "Radisson Rosa Khutor" }], input: {} }, 2),
    ).rejects.toThrow(/none of the page's items/);
  });
});

describe("annotateAny", () => {
  it("types plain parameters and leaves the rest alone", () => {
    expect(annotateAny("async (input, fetchJson) => xs.map(o => o.id).filter((id) => !!id)")).toBe(
      "async (input: any, fetchJson: any) => xs.map((o: any) => o.id).filter((id: any) => !!id)",
    );
    expect(annotateAny("xs.map(({ id }) => id).reduce((a, [b]) => a, 0); f(() => 1); g(async x => x)")).toBe(
      "xs.map(({ id }) => id).reduce((a, [b]) => a, 0); f(() => 1); g(async (x: any) => x)",
    );
    expect(annotateAny("function pick(o, k) { return o[k]; }")).toBe("function pick(o: any, k: any) { return o[k]; }");
    expect(annotateAny("const s = 'a => b'; x.y => 1")).toContain("x.y => 1");
  });

  it("keeps the code runnable after stripping nothing (validation runs the original)", async () => {
    const code = "async (input, fetchJson) => ({ items: (await fetchJson({ url: '/x' })).list.map(o => ({ title: o.t })) })";
    const out = await compileChain(code)({}, async () => ({ list: [{ t: "a" }] }));
    expect(out).toEqual({ items: [{ title: "a" }] });
  });
});

const typecheck = (source: string) => {
  const dir = mkdtempSync(join(process.cwd(), ".scratch-render-"));
  try {
    writeFileSync(join(dir, "site.ts"), source.replace('from "@mamkincoder/webtap"', 'from "../src/index.js"'));
    execFileSync(
      "npx",
      ["tsc", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2023", "--skipLibCheck", join(dir, "site.ts")],
      { stdio: "pipe" },
    );
  } catch (err) {
    throw new Error(String((err as { stdout?: Buffer }).stdout ?? err));
  } finally {
    execFileSync("rm", ["-rf", dir]);
  }
};

describe("renderSite", () => {
  it("renders a chain-based site file that typechecks", () => {
    const source = renderSite({
      id: "stays",
      endpoint: "search",
      goal: "find stays",
      origin: "https://s.example",
      startUrl: "https://s.example/",
      inputs: { city: "Сочи", checkIn: "2026-10-16" },
      fields: parseFields("title,priceRub:number?,url"),
      chain: { code: "async (input, fetchJson) => { const r = await fetchJson({ url: '/api?q=' + encodeURIComponent(input.city) }); const ids = (r.list ?? []).map(o => o.id).filter((id) => id); return { items: ids.map(function (id) { return { title: String(id), url: '/o/' + id }; }) }; }", http: true, pageFetch: false, calls: ["#0 GET https://s.example/api?q=Сочи"] },
      steps: [{ kind: "goto", value: "https://s.example/search?term=%city%&from=%checkIn%" }],
      date: "2026-10-02",
      notes: [],
    });
    expect(source).toContain("requests({ run })");
    expect(source).toContain("await s.goto(`https://s.example/search?term=${encodeURIComponent(String(i.city))}&from=${encodeURIComponent(String(i.checkIn))}`);");
    typecheck(source);
  }, 60_000);

  it("renders a site file that typechecks", () => {
    const t = toTemplate(
      ex({ url: "https://travel.example/api/search?city=%D0%A1%D0%BE%D1%87%D0%B8", method: "POST", postData: '{"q":"Сочи","n":`2`}'.replace("`2`", "2"), requestHeaders: { "x-device": "d" } }),
      { city: "Сочи" },
    );
    const source = renderSite({
      id: "travel-example",
      endpoint: "search",
      goal: "find hotels in a city",
      origin: "https://travel.example",
      startUrl: "https://travel.example/hotels/",
      inputs: { city: "Сочи" },
      fields: parseFields("title,priceRub:number?,url"),
      request: { template: t, http: true, pageFetch: true, parseCode: "(json) => ({ items: json.hotels })", recordedUrl: "https://travel.example/api/search" },
      steps: [{ kind: "act", value: "type %city% into the destination field" }],
      date: "2026-10-02",
      notes: ["sample note"],
    });
    expect(source).toContain("http({ request, parse })");
    expect(source).toContain("${encodeURIComponent(String(i.city))}");
    expect(source).toContain("q: i.city");
    typecheck(source);
  }, 60_000);
});
