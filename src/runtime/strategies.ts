// The three ways to run an endpoint, cheapest first:
//   http()       plain HTTP from Node through the identity's proxy            ~100 ms, KB of traffic
//   pageFetch()  the same request made by fetch() inside a warm browser tab   ~500 ms: the browser's TLS, cookies and
//                anti-bot tokens, so it passes where plain HTTP is challenged
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

export function pageFetch<I, O>(o: PageFetchStrategyOptions<I, O>): Strategy<I, O> {
  const settle = o.settleMs ?? 3_000;
  return {
    kind: "page-fetch",
    name: o.name ?? "page-fetch",
    async run(ctx, input) {
      const s = await ctx.session();
      const warm = new URL(o.warmUrl, ctx.site.origin).toString();
      const warmUp = async () => {
        await s.goto(warm);
        await sleep(settle);
      };
      if (!sameOrigin(await s.url().catch(() => ""), warm)) await warmUp();
      const req = o.request(input, ctx);
      const once = async () => parseJsonBody(await inPage(s, req, ctx.site.origin));
      let json: unknown;
      try {
        json = await once();
      } catch (err) {
        // A stale or unsolved challenge: reopen the warm page once, let its scripts run, retry.
        if (!(err instanceof StrategyFailure) || err.outcome !== "banned") throw err;
        await warmUp();
        json = await once();
      }
      return parseWith(o.parse, json, input);
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
