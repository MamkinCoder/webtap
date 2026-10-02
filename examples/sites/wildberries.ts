// Wildberries product search.
//
// Every request to wildberries.ru passes the "wbaas" anti-bot check first (HTTP 498 + a JS challenge that sets the
// x_wbaas_token cookie), so plain HTTP from Node never gets through. Recorded from the site's own frontend (2026-10):
// search is GET /__internal/u-search/exactmatch/ru/common/v18/search on the same origin, and it answers 403 unless the
// request carries a `deviceid` header ("site_" + 32 hex). Prices are in kopecks.
//
// Strategies: page-fetch (that call from inside a warm tab), then browser (open the search page, LLM extract).
//
// Images: https://<host>/vol<id/1e5>/part<id/1e3>/<id>/images/c246x328/1.webp, where the host comes from WB's own
// published map (cdn.wbbasket.ru/api/v3/upstreams → origin.mediabasket_route_map: volume ranges per basket host). WB
// adds hosts as the catalogue grows (65 in 2026-10), so the map is fetched and cached, never hard-coded.
import { createHash } from "node:crypto";
import { browser, defineSite, endpoint, pageFetch, transient, type Strategy, type StrategyContext, z } from "../../src/index.js";

const Product = z.object({
  id: z.number(),
  title: z.string(),
  brand: z.string().optional(),
  seller: z.string().optional(),
  priceRub: z.number(),
  oldPriceRub: z.number().optional(),
  rating: z.number().optional(),
  reviews: z.number().optional(),
  url: z.string(),
  imageUrl: z.string().optional(),
});

const SORTS = ["popular", "priceup", "pricedown", "rate", "newly"] as const;

/** A stable device id per identity, like a returning visitor's. */
const deviceId = (ctx: StrategyContext): string => `site_${createHash("sha256").update(`wb:${ctx.identity.id}`).digest("hex").slice(0, 32)}`;

type WbProduct = {
  id: number;
  name: string;
  brand?: string;
  supplier?: string;
  reviewRating?: number;
  feedbacks?: number;
  sizes?: { price?: { basic?: number; product?: number } }[];
};

const rub = (kopecks: number | undefined): number | undefined => (kopecks ? Math.round(kopecks / 100) : undefined);

// ── Image hosts ──────────────────────────────────────────────────────────────
type VolRange = { from: number; to: number; host: string };
const UPSTREAMS_URL = "https://cdn.wbbasket.ru/api/v3/upstreams";
const IMAGE_MAP_TTL_MS = 6 * 60 * 60_000;
let imageMap: { ranges: VolRange[]; fetchedAt: number } | undefined;
let imageMapLoading: Promise<VolRange[]> | undefined;

export function parseImageRanges(json: unknown): VolRange[] {
  const maps = (json as { origin?: { mediabasket_route_map?: { method?: string; hosts?: { vol_range_from?: number; vol_range_to?: number; host?: string }[] }[] } })
    ?.origin?.mediabasket_route_map;
  const ranges = (maps ?? [])
    .filter((m) => m.method === "range")
    .flatMap((m) => m.hosts ?? [])
    .filter((h) => typeof h.vol_range_from === "number" && typeof h.vol_range_to === "number" && typeof h.host === "string")
    .map((h) => ({ from: h.vol_range_from!, to: h.vol_range_to!, host: h.host! }));
  if (!ranges.length) throw new Error("no mediabasket ranges in the upstreams map");
  return ranges;
}

export function wbImageUrl(id: number, ranges: VolRange[]): string | undefined {
  const vol = Math.floor(id / 100_000);
  const host = ranges.find((r) => vol >= r.from && vol <= r.to)?.host;
  return host ? `https://${host}/vol${vol}/part${Math.floor(id / 1_000)}/${id}/images/c246x328/1.webp` : undefined;
}

/** The cached map; refetched after the TTL. A failed fetch keeps the old map (or none): images are optional. */
async function imageRanges(ctx: StrategyContext): Promise<VolRange[]> {
  if (imageMap && Date.now() - imageMap.fetchedAt < IMAGE_MAP_TTL_MS) return imageMap.ranges;
  imageMapLoading ??= (async () => {
    try {
      const res = await ctx.fetch({ url: UPSTREAMS_URL });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const ranges = parseImageRanges(JSON.parse(res.body));
      imageMap = { ranges, fetchedAt: Date.now() };
      return ranges;
    } catch (err) {
      console.warn(`[webtap] wildberries image map: ${err instanceof Error ? err.message : String(err)}`);
      return imageMap?.ranges ?? [];
    } finally {
      imageMapLoading = undefined;
    }
  })();
  return imageMapLoading;
}

type Output = { total?: number; items: (z.output<typeof Product>)[] };

/** Adds imageUrl to a strategy's products; the map is fetched alongside the search, not after it. */
const withImages = <I>(s: Strategy<I, Output>): Strategy<I, Output> => ({
  ...s,
  async run(ctx, input) {
    const [out, ranges] = await Promise.all([s.run(ctx, input), imageRanges(ctx)]);
    return {
      ...out,
      items: out.items.map((p) => {
        const imageUrl = p.imageUrl ?? (p.id ? wbImageUrl(p.id, ranges) : undefined);
        return imageUrl ? { ...p, imageUrl } : p;
      }),
    };
  },
});

export const wildberries = defineSite({
  id: "wildberries",
  origin: "https://www.wildberries.ru",
  description: "Wildberries marketplace",
  rateLimit: { minIntervalMs: 2_000 },
  endpoints: {
    search: endpoint(
      {
        description: "Search products. Prices in rubles, with the discount applied.",
        input: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(100).default(20),
          page: z.number().int().min(1).default(1),
          sort: z.enum(SORTS).default("popular"),
          /** Delivery region id; -1257786 = Moscow. */
          dest: z.number().int().default(-1257786),
        }),
        output: z.object({ total: z.number().optional(), items: z.array(Product) }),
      },
      {
        strategies: [
          withImages(pageFetch({
            warmUrl: "/",
            settleMs: 4_000,
            request: (i, ctx) => ({
              url:
                "/__internal/u-search/exactmatch/ru/common/v18/search?ab_testing=false&appType=1&curr=rub&lang=ru&locale=ru&resultset=catalog&spp=30" +
                `&dest=${i.dest}&page=${i.page}&sort=${i.sort}&query=${encodeURIComponent(i.query)}`,
              headers: { deviceid: deviceId(ctx), "x-requested-with": "XMLHttpRequest", "x-userid": "0" },
            }),
            parse: (json: { products?: WbProduct[]; total?: number; query?: unknown }, i) => {
              // A real "nothing found" has its own shape ({ name, query, shardKey, filters, … }, no products). An
              // empty answer without it is WB refusing quietly: retry instead of telling the operator there is nothing.
              if (!json.products?.length && typeof json.query !== "string") throw transient("empty answer without a no-results marker");
              return {
                ...(json.total !== undefined ? { total: json.total } : {}),
                items: (json.products ?? []).slice(0, i.limit).map((p) => {
                  const price = p.sizes?.find((s) => s.price?.product)?.price;
                  const priceRub = rub(price?.product);
                  if (priceRub === undefined) throw new Error(`no price for product ${p.id}`);
                  const oldPriceRub = rub(price?.basic);
                  return {
                    id: p.id,
                    title: p.name,
                    ...(p.brand ? { brand: p.brand } : {}),
                    ...(p.supplier ? { seller: p.supplier } : {}),
                    priceRub,
                    ...(oldPriceRub && oldPriceRub > priceRub ? { oldPriceRub } : {}),
                    ...(p.reviewRating ? { rating: p.reviewRating } : {}),
                    ...(p.feedbacks !== undefined ? { reviews: p.feedbacks } : {}),
                    url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
                  };
                }),
              };
            },
          })),
          // Last resort: the search page itself, read by the LLM (needs an llm in createWebtap).
          withImages(browser({
            run: async (s, i) => {
              await s.goto(`https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(i.query)}&sort=${i.sort}`);
              const page = await s.extract(
                `The product cards in the search results (at most ${i.limit}): title, brand, current price in rubles, the product page url`,
                z.object({ items: z.array(z.object({ title: z.string(), brand: z.string().optional(), priceRub: z.number(), url: z.string() })) }),
              );
              return {
                items: page.items.slice(0, i.limit).map((p) => ({
                  id: Number(/catalog\/(\d+)/.exec(p.url)?.[1] ?? 0),
                  title: p.title,
                  ...(p.brand ? { brand: p.brand } : {}),
                  priceRub: p.priceRub,
                  url: new URL(p.url, "https://www.wildberries.ru").toString(),
                })),
              };
            },
          })),
        ],
        canary: { input: { query: "наушники", limit: 5 } },
      },
    ),
  },
});
