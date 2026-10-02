// Avito search: cars, services (сантехник, электрик…) and any listing.
//
// Avito blocks headless Chrome and plain HTTP with 429 "Доступ ограничен: проблема с IP" (2026-10), while a headful
// Chrome passes, so this site runs headful: off-screen on a desktop, on a virtual display (Xvfb) in Docker. It also
// rate-limits hard: a burst of searches gets the IP banned for a while, hence one search at a time, seconds apart.
//
// Data: the search page embeds its state as HTML-escaped JSON in <script type="mime/invalid" data-mfe-state="true">;
// the listings are state.data.catalog.items (the same source the old Python parser read). No LLM involved.
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
  id?: number;
  title?: string;
  urlPath?: string;
  description?: string;
  priceDetailed?: { value?: number; string?: string; fullString?: string };
  images?: Record<string, string>[];
  geo?: { formattedAddress?: string };
  addressDetailed?: { locationName?: string };
  location?: { name?: string };
};

// Runs in the page: the state JSON's listings, trimmed to what the recipe maps (keeps the CDP payload small).
const EXTRACT_JS = `(function(){
  var blocked = /Доступ ограничен|проблема с IP/i.test(document.title);
  var scripts = document.querySelectorAll('script[type="mime/invalid"][data-mfe-state="true"]');
  var decode = document.createElement("textarea");
  for (var k = 0; k < scripts.length; k++) {
    var raw = scripts[k].textContent || "";
    if (raw.indexOf("sandbox") >= 0 && raw.indexOf("catalog") < 0) continue;
    decode.innerHTML = raw;
    try { var data = JSON.parse(decode.value); } catch (e) { continue; }
    var catalog = data && data.state && data.state.data && data.state.data.catalog;
    if (!catalog || !catalog.items) continue;
    return JSON.stringify({ blocked: blocked, items: catalog.items.map(function(it){
      return { id: it.id, title: it.title, urlPath: it.urlPath, description: it.description, priceDetailed: it.priceDetailed,
        images: (it.images || []).slice(0, 1), geo: it.geo, addressDetailed: it.addressDetailed, location: it.location };
    }) });
  }
  return JSON.stringify({ blocked: blocked, items: null, title: document.title });
})()`;

export function parseAvitoItems(raw: RawItem[], limit: number): AvitoListing[] {
  return raw
    .filter((it) => typeof it.id === "number" && it.title && it.urlPath)
    .slice(0, limit)
    .map((it) => {
      const img = it.images?.[0];
      const imageUrl = img ? (img["472x355"] ?? img["208x156"] ?? Object.values(img)[0]) : undefined;
      const address = it.geo?.formattedAddress || it.addressDetailed?.locationName || it.location?.name;
      const description = it.description?.replace(/\s+/g, " ").trim().slice(0, 200);
      return {
        id: it.id!,
        title: it.title!,
        ...(typeof it.priceDetailed?.value === "number" && it.priceDetailed.value > 0 ? { priceRub: it.priceDetailed.value } : {}),
        ...(it.priceDetailed?.fullString || it.priceDetailed?.string ? { priceText: (it.priceDetailed.fullString || it.priceDetailed.string)! } : {}),
        ...(address ? { address } : {}),
        ...(description ? { description } : {}),
        url: `https://www.avito.ru${it.urlPath}`,
        ...(imageUrl ? { imageUrl } : {}),
      };
    });
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export const avito = defineSite({
  id: "avito",
  origin: "https://www.avito.ru",
  description: "Avito classifieds: cars, services, goods",
  // One search at a time per identity, well apart: bursts get the IP banned.
  rateLimit: { minIntervalMs: 8_000, maxConcurrent: 1 },
  banCooldownMs: 30 * 60_000,
  browser: { headless: false, blockAssets: false, loadImages: true },
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
              // Arrive like a visitor: the homepage first when this tab is new to Avito, a pause, then the search.
              if (!(await s.url().catch(() => "")).startsWith("https://www.avito.ru")) {
                await s.goto("https://www.avito.ru/");
                await sleep(rnd(2_500, 4_500));
              }
              await s.goto(avitoSearchUrl(i));
              await s.humanize([], rnd(1_200, 2_500));
              const out = JSON.parse(await s.evaluate<string>(EXTRACT_JS)) as { blocked: boolean; items: RawItem[] | null; title?: string };
              if (out.blocked) throw banned("Avito: Доступ ограничен (IP / bot check)");
              if (!out.items) throw changed(`no catalog state on the search page (${out.title ?? "?"})`);
              return { items: parseAvitoItems(out.items, i.limit) };
            },
          }),
        ],
        canary: { input: { query: "сантехник", city: "Москва", category: "services", limit: 3 } },
      },
    ),
  },
});
