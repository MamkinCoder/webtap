// The three ways to run an endpoint, cheapest first:
//   http()       plain HTTP from Node through the identity's proxy            ~100 ms, KB of traffic
//   pageFetch()  the same request made by fetch() inside a warm browser tab   ~500 ms: the browser's TLS, cookies and
//                anti-bot tokens, so it passes where plain HTTP is challenged
//   requests()   several dependent calls (suggest → id → search → details), over HTTP or inside the tab
//   browser()    drive the page (act / extract, cached selectors + healing)   seconds, MB of traffic, the last resort
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserSession } from "../types.js";
import { StrategyFailure, changed, parseJsonBody } from "./outcome.js";
import type { HttpRequest, HttpResponse, Strategy, StrategyContext } from "./site.js";

/** Runs a recipe's parse step: anything it throws (a missing field, a TypeError) means the shape changed. */
function parseWith<I, O>(parse: (json: any, input: I) => O, json: unknown, input: I): O {
  try {
    return parse(json, input);
  } catch (err) {
    if (err instanceof StrategyFailure) throw err;
    throw changed(`parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface HttpStrategyOptions<I, O> {
  name?: string;
  /** ctx gives the identity, e.g. for a per-identity device id. */
  request: (input: I, ctx: StrategyContext) => HttpRequest;
  /** Maps the JSON body to the endpoint's output. Throwing = the response shape changed. */
  parse: (json: any, input: I) => O;
}

export function http<I, O>(o: HttpStrategyOptions<I, O>): Strategy<I, O> {
  return {
    kind: "http",
    name: o.name ?? "http",
    async run(ctx, input) {
      const res = await ctx.fetch(o.request(input, ctx));
      return parseWith(o.parse, parseJsonBody(res), input);
    },
  };
}

export interface PageFetchStrategyOptions<I, O> {
  name?: string;
  /** A page of the site to open first, so its scripts set cookies / solve the anti-bot challenge. */
  warmUrl: string;
  request: (input: I, ctx: StrategyContext) => HttpRequest;
  parse: (json: any, input: I) => O;
  /** Wait after opening warmUrl for challenge scripts to finish. Default 3000. */
  settleMs?: number;
}

/** The identity's tab, on the site's warm page; `rewarm` reopens it so the site's scripts can renew their tokens. */
async function warmTab(ctx: StrategyContext, warmUrl: string, settleMs: number): Promise<{ s: BrowserSession; rewarm: () => Promise<void> }> {
  const s = await ctx.session();
  const warm = new URL(warmUrl, ctx.site.origin).toString();
  const rewarm = async () => {
    await s.goto(warm);
    await sleep(settleMs);
  };
  if (!sameOrigin(await s.url().catch(() => ""), warm)) await rewarm();
  return { s, rewarm };
}

/** Runs `fn`; on a ban (stale or unsolved challenge) reopens the warm page once and retries. */
async function retryAfterRewarm<T>(fn: () => Promise<T>, rewarm: () => Promise<void>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof StrategyFailure) || err.outcome !== "banned") throw err;
    await rewarm();
    return fn();
  }
}

export function pageFetch<I, O>(o: PageFetchStrategyOptions<I, O>): Strategy<I, O> {
  return {
    kind: "page-fetch",
    name: o.name ?? "page-fetch",
    async run(ctx, input) {
      const { s, rewarm } = await warmTab(ctx, o.warmUrl, o.settleMs ?? 3_000);
      const req = o.request(input, ctx);
      const json = await retryAfterRewarm(async () => parseJsonBody(await inPage(s, req, ctx.site.origin)), rewarm);
      return parseWith(o.parse, json, input);
    },
  };
}

/** Makes one request and returns its JSON body; failures are classified like any strategy's (banned / changed / error). */
export type FetchJson = (req: HttpRequest) => Promise<any>;

export interface RequestsStrategyOptions<I, O> {
  name?: string;
  /** "http" (default): plain HTTP from Node. "page": fetch() inside the warm tab (needs warmUrl). */
  via?: "http" | "page";
  warmUrl?: string;
  settleMs?: number;
  /** Several dependent calls (a suggest call → an id → a search call → details), mapped to the output. */
  run: (input: I, fetchJson: FetchJson) => Promise<O>;
}

/** A chain of requests: for sites where the data call needs ids that earlier calls return. */
export function requests<I, O>(o: RequestsStrategyOptions<I, O>): Strategy<I, O> {
  const page = o.via === "page";
  return {
    kind: page ? "page-fetch" : "http",
    name: o.name ?? (page ? "page-fetch" : "http"),
    async run(ctx, input) {
      let fetchJson: FetchJson;
      let rewarm: (() => Promise<void>) | undefined;
      if (page) {
        const tab = await warmTab(ctx, o.warmUrl ?? "/", o.settleMs ?? 3_000);
        rewarm = tab.rewarm;
        fetchJson = async (req) => parseJsonBody(await inPage(tab.s, req, ctx.site.origin));
      } else {
        fetchJson = async (req) => parseJsonBody(await ctx.fetch(req));
      }
      const once = async () => {
        try {
          return await o.run(input, fetchJson);
        } catch (err) {
          if (err instanceof StrategyFailure) throw err;
          throw changed(`request chain failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      return rewarm ? retryAfterRewarm(once, rewarm) : once();
    },
  };
}

async function inPage(s: BrowserSession, req: HttpRequest, origin: string): Promise<HttpResponse> {
  const { body, headers } = encodeBody(req);
  return s.fetch(new URL(req.url, origin).toString(), {
    method: req.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

export interface BrowserStrategyOptions<I, O> {
  name?: string;
  /** Drive the page: goto, act (cached + healed), extract. Throw changed()/banned() when you can tell. */
  run: (s: BrowserSession, input: I, ctx: StrategyContext) => Promise<O>;
}

export function browser<I, O>(o: BrowserStrategyOptions<I, O>): Strategy<I, O> {
  return {
    kind: "browser",
    name: o.name ?? "browser",
    async run(ctx, input) {
      return o.run(await ctx.session(), input, ctx);
    },
  };
}

/** A string body is sent as is; anything else as JSON. */
export function encodeBody(req: HttpRequest): { body: string | undefined; headers: Record<string, string> } {
  const headers = { ...(req.headers ?? {}) };
  if (req.body === undefined) return { body: undefined, headers };
  if (typeof req.body === "string") return { body: req.body, headers };
  if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  return { body: JSON.stringify(req.body), headers };
}

const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};
