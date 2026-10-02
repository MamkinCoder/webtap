// Avito search: cars, services (сантехник, электрик…) and any listing.
//
// Avito (2026-10) runs a proof-of-work JS challenge (HTTP 439, pow_challenge → pow_solved cookies) and bans the IP
// (429 "Доступ ограничен: проблема с IP") of any browser it catches being automated: plain HTTP, headless Chrome,
// and Stagehand/Playwright-driven Chrome alike. A plain Chrome passes, so this site runs on webtap's "clean" engine
// (Chrome started without automation flags, opening avito.ru by itself; driven without in-page instrumentation).
// It also bans bursts: one search at a time, seconds apart.
//
// Data: the rendered result cards ([data-marker=item]); the old embedded-state JSON is gone. No LLM involved.
import { setTimeout as sleep } from "node:timers/promises";
import { banned, browser, changed, defineSite, endpoint, z } from "../../src/index.js";

const CATEGORY_PATH = { all: "", cars: "/avtomobili", services: "/predlozheniya_uslug" } as const;

// Avito's location slugs for the cities customers name most; anything else searches all of Russia with the city in
// the query.
const CITY_SLUG: Record<string, string> = {
  "москва": "moskva",
  "московская область": "moskovskaya_oblast",
  "санкт-петербург": "sankt-peterburg",
  "петербург": "sankt-peterburg",
  "спб": "sankt-peterburg",
  "новосибирск": "novosibirsk",
  "екатеринбург": "ekaterinburg",
  "казань": "kazan",
  "нижний новгород": "nizhniy_novgorod",
  "челябинск": "chelyabinsk",
  "самара": "samara",
  "омск": "omsk",
  "ростов-на-дону": "rostov-na-donu",
  "уфа": "ufa",
  "красноярск": "krasnoyarsk",
  "воронеж": "voronezh",
  "пермь": "perm",
  "волгоград": "volgograd",
  "краснодар": "krasnodar",
  "саратов": "saratov",
  "тюмень": "tyumen",
  "сочи": "sochi",
  "калининград": "kaliningrad",
  "ярославль": "yaroslavl",
  "тула": "tula",
};

export function avitoSearchUrl(i: { query: string; city?: string | undefined; category: keyof typeof CATEGORY_PATH }): string {
  const city = i.city?.trim().toLowerCase().replace(/^г\.?\s*/, "");
  const slug = city ? CITY_SLUG[city] : undefined;
  const q = slug || !i.city ? i.query : `${i.query} ${i.city}`;
  return `https://www.avito.ru/${slug ?? "rossiya"}${CATEGORY_PATH[i.category]}?q=${encodeURIComponent(q)}`;
}

const Listing = z.object({
  id: z.number(),
  title: z.string(),
  priceRub: z.number().optional(),
  /** As Avito shows it: "1 250 000 ₽", "от 1 500 ₽ за услугу", "Цена не указана". */
  priceText: z.string().optional(),
  address: z.string().optional(),
  description: z.string().optional(),
  url: z.string(),
  imageUrl: z.string().optional(),
});
export type AvitoListing = z.output<typeof Listing>;

type RawItem = {
  id?: string;
  title?: string;
  href?: string;
  price?: string;
  priceText?: string;
  img?: string;
  location?: string;
  params?: string;
};

// Runs in the page: the visible result cards via Avito's own data-markers (stable for years, used by its tests).
const EXTRACT_JS = `(function(){
  var blocked = /Доступ ограничен|проблема с IP|проверка безопасности/i.test(document.title);
  var text = function(el){ return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : undefined; };
  var items = Array.prototype.map.call(document.querySelectorAll('[data-marker="item"]'), function(it){
    var q = function(sel){ return it.querySelector(sel); };
    var a = q('a[data-marker="item-title"]') || q('a[itemprop="url"]');
    var img = q('img');
    var price = q('meta[itemprop="price"]');
    return {
      id: it.getAttribute("data-item-id") || undefined,
      title: text(q('[itemprop="name"]')) || text(a),
      href: a ? a.getAttribute("href") : undefined,
      price: price ? price.getAttribute("content") : undefined,
      priceText: text(q('[data-marker="item-price"]')),
      img: img ? (img.getAttribute("src") || img.getAttribute("data-src") || undefined) : undefined,
      location: text(q('[data-marker="item-location"]')) || text(q('[data-marker="item-address"]')),
      params: text(q('[data-marker="item-specific-params"]'))
    };
  });
  return JSON.stringify({ blocked: blocked, title: document.title, items: items });
})()`;

export function parseAvitoItems(raw: RawItem[], limit: number): AvitoListing[] {
  const out: AvitoListing[] = [];
  for (const it of raw) {
    const id = Number(it.id);
    if (!id || !it.title || !it.href) continue;
    const priceRub = Number(it.price);
    const url = new URL(it.href, "https://www.avito.ru");
    url.search = ""; // drop the tracking context
    out.push({
      id,
      title: it.title,
      ...(priceRub > 0 ? { priceRub } : {}),
      ...(it.priceText ? { priceText: it.priceText } : {}),
      ...(it.location ? { address: it.location } : {}),
      ...(it.params ? { description: it.params.slice(0, 200) } : {}),
      url: url.toString(),
      ...(it.img && /^https?:/.test(it.img) ? { imageUrl: it.img } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export const avito = defineSite({
  id: "avito",
  origin: "https://www.avito.ru",
  description: "Avito classifieds: cars, services, goods",
  // One search at a time per identity, well apart: bursts get the IP banned.
  rateLimit: { minIntervalMs: 8_000, maxConcurrent: 1 },
  // Avito bans home and datacenter IPs quickly: only proxy identities (a Russian mobile proxy, IP rotation on a ban).
  requireProxy: true,
  banCooldownMs: 30 * 60_000,
  browser: { engine: "clean", headless: false, blockAssets: false, loadImages: true },
  endpoints: {
    search: endpoint(
      {
        description: "Search Avito listings (cars, services, goods) in a city.",
        input: z.object({
          query: z.string().min(1),
          /** Russian city name; unknown cities search all of Russia. */
          city: z.string().optional(),
          category: z.enum(["all", "cars", "services"]).default("all"),
          limit: z.number().int().min(1).max(50).default(10),
        }),
        output: z.object({ items: z.array(Listing) }),
      },
      {
        strategies: [
          browser({
            run: async (s, i) => {
              // The clean engine opened avito.ru itself (the challenge ran there); a lost tab goes back home first.
              if (!(await s.url().catch(() => "")).startsWith("https://www.avito.ru")) {
                await s.goto("https://www.avito.ru/");
                await sleep(rnd(2_500, 4_500));
              }
              await s.goto(avitoSearchUrl(i));
              await s.waitForSelector('[data-marker="item"]', 10_000);
              await s.humanize([], rnd(1_200, 2_500));
              const out = JSON.parse(await s.evaluate<string>(EXTRACT_JS)) as { blocked: boolean; title: string; items: RawItem[] };
              if (out.blocked) throw banned(`Avito: ${out.title}`);
              const items = parseAvitoItems(out.items, i.limit);
              // A real "nothing found" page still renders; an empty page without cards is not a result.
              if (!items.length && !(await s.text(4_000)).match(/ничего не найдено|не нашли|Нет объявлений/i)) throw changed(`no result cards on the search page (${out.title})`);
              return { items };
            },
          }),
        ],
        canary: { input: { query: "сантехник", city: "Москва", category: "services", limit: 3 } },
      },
    ),
  },
});
