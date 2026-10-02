// Yandex Eda: restaurants (with matching dishes and prices) that deliver to a point.
//
// Recorded from the site's own frontend (2026-10): POST /eats/v1/full-text-search/v1/search with
// { text, location: { latitude, longitude } } answers plain HTTP from a residential IP. Blocks of type "places" list
// restaurants; each carries the dishes that matched, rating in lower_meta ("4.4 (2800+)"), delivery time, a web link.
//
// Strategies: http (Node), then page-fetch (the same call inside a warm eda.yandex.ru tab, for when Node is challenged).
import { z } from "zod";
import { defineSite, endpoint, http, pageFetch, type HttpRequest } from "../../src/index.js";

const Dish = z.object({ title: z.string(), priceRub: z.number().optional(), weight: z.string().optional(), imageUrl: z.string().optional() });
const Place = z.object({
  title: z.string(),
  slug: z.string(),
  url: z.string(),
  available: z.boolean(),
  rating: z.number().optional(),
  ratingCount: z.string().optional(),
  deliveryTime: z.string().optional(),
  priceCategory: z.string().optional(),
  imageUrl: z.string().optional(),
  tags: z.array(z.string()),
  dishes: z.array(Dish),
});

type EdaItem = { title?: string; decimal_price?: string; weight?: string; gallery?: { url?: string }[] };
type EdaPlace = {
  title?: string;
  slug?: string;
  available?: boolean;
  picture?: { url?: string };
  tags?: { title?: string }[];
  price_category?: { title?: string };
  delivery?: { text?: string };
  link?: { web?: string };
  lower_meta?: { payload?: { icon?: { icon?: { url?: string } }; text?: { value?: string } } }[];
  items?: EdaItem[];
};
type EdaSearch = { blocks?: { type?: string; payload?: unknown }[] };

const image = (tmpl: string | undefined): string | undefined => (tmpl ? `https://eda.yandex${tmpl.replace("{w}x{h}", "400x300")}` : undefined);

function rating(p: EdaPlace): { rating?: number; ratingCount?: string } {
  const meta = p.lower_meta?.find((m) => m.payload?.icon?.icon?.url?.includes("rating"))?.payload?.text?.value;
  const m = meta ? /^([\d.,]+)\s*(?:\(([^)]+)\))?/.exec(meta) : null;
  if (!m?.[1]) return {};
  return { rating: Number(m[1].replace(",", ".")), ...(m[2] ? { ratingCount: m[2] } : {}) };
}

const Input = z.object({
  query: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  limit: z.number().int().min(1).max(50).default(10),
});
type Input = z.output<typeof Input>;

const request = (i: Input): HttpRequest => ({
  url: "/eats/v1/full-text-search/v1/search",
  method: "POST",
  headers: { "x-platform": "desktop_web", origin: "https://eda.yandex.ru", referer: "https://eda.yandex.ru/" },
  body: { text: i.query, location: { latitude: i.latitude, longitude: i.longitude } },
});

function parse(json: EdaSearch, i: Input) {
  if (!Array.isArray(json.blocks)) throw new Error("no blocks in the search response");
  const places = json.blocks.filter((b) => b.type === "places").flatMap((b) => (Array.isArray(b.payload) ? (b.payload as EdaPlace[]) : []));
  return {
    items: places.slice(0, i.limit).map((p) => {
      if (!p.title || !p.slug) throw new Error("place without title/slug");
      const img = image(p.picture?.url);
      return {
        title: p.title,
        slug: p.slug,
        url: `https://eda.yandex.ru${p.link?.web ?? `/r/${p.slug}`}`,
        available: p.available !== false,
        ...rating(p),
        ...(p.delivery?.text ? { deliveryTime: p.delivery.text } : {}),
        ...(p.price_category?.title ? { priceCategory: p.price_category.title } : {}),
        ...(img ? { imageUrl: img } : {}),
        tags: (p.tags ?? []).map((t) => t.title).filter((t): t is string => !!t),
        dishes: (p.items ?? []).map((d) => {
          const dishImg = image(d.gallery?.[0]?.url);
          return {
            title: d.title ?? "",
            ...(d.decimal_price ? { priceRub: Number(d.decimal_price) } : {}),
            ...(d.weight ? { weight: d.weight } : {}),
            ...(dishImg ? { imageUrl: dishImg } : {}),
          };
        }),
      };
    }),
  };
}

export const yandexEda = defineSite({
  id: "yandex-eda",
  origin: "https://eda.yandex.ru",
  description: "Yandex Eda food delivery",
  rateLimit: { minIntervalMs: 1_500 },
  endpoints: {
    search: endpoint(
      {
        description: "Restaurants delivering to a point that match a dish or cuisine, with the matching dishes and prices.",
        input: Input,
        output: z.object({ items: z.array(Place) }),
      },
      {
        strategies: [http({ request, parse }), pageFetch({ warmUrl: "/", request, parse })],
        canary: { input: { query: "бургер", latitude: 55.751244, longitude: 37.618423, limit: 5 } },
      },
    ),
  },
});
