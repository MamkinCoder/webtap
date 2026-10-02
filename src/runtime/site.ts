// What an integration is: a site with named endpoints. Each endpoint has a typed input and output and an ordered list
// of strategies (cheapest first); the runtime runs the first one that returns valid output, from a healthy identity.
import type { z, ZodType } from "zod";
import type { BrowserSession, ProxyConfig } from "../types.js";

export type StrategyKind = "http" | "page-fetch" | "browser";

/** An exit to the internet plus a browser persona: rate limits, bans and cookies are tracked per identity per site. */
export interface Identity {
  id: string;
  /** Omitted: this machine's own IP. */
  proxy?: ProxyConfig;
  userAgent?: string;
  languages?: string[];
}

export interface HttpRequest {
  /** Absolute, or relative to the site's origin. */
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** A string is sent as is; anything else as JSON (content-type set unless given). */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
}

export interface StrategyContext {
  site: SiteDef;
  identity: Identity;
  /** Plain HTTP through the identity's proxy, with its user agent and languages. */
  fetch(req: HttpRequest): Promise<HttpResponse>;
  /** This identity's warm browser for this site, held exclusively until the strategy returns. */
  session(): Promise<BrowserSession>;
  signal: AbortSignal;
}

export interface Strategy<I, O> {
  kind: StrategyKind;
  /** Unique within the endpoint; shows up in health and logs. Defaults to the kind. */
  name: string;
  run(ctx: StrategyContext, input: I): Promise<O>;
}

export interface Endpoint<IS extends ZodType = ZodType, OS extends ZodType = ZodType> {
  description?: string;
  input: IS;
  output: OS;
  /** Tried in order; put the cheapest (http) first and the browser last. */
  strategies: Strategy<z.output<IS>, z.output<OS>>[];
  /** Semantic check beyond the schema. A string = the output is wrong (counts as "changed"). */
  verify?: (output: z.output<OS>, input: z.output<IS>) => string | null;
  /** Known-good call for runCanaries(). `check` defaults to "at least one item in the first array found". */
  canary?: { input: z.input<IS>; check?: (output: z.output<OS>) => string | null };
  /** Whole call budget across strategies. Default 60000. */
  timeoutMs?: number;
}

export interface SiteDef {
  id: string;
  /** e.g. "https://www.wildberries.ru": relative strategy urls resolve against it. */
  origin: string;
  description?: string;
  /** Per identity: at most one request every minIntervalMs to this site. Default 1000. */
  rateLimit?: { minIntervalMs?: number; maxConcurrent?: number };
  /** First quarantine of an identity after a ban; doubles on repeats (max 6 h). Default 10 min. */
  banCooldownMs?: number;
  /** Browser settings for this site's sessions. */
  browser?: { blockAssets?: boolean; loadImages?: boolean; headless?: boolean; blockUrls?: string[] };
  endpoints: Record<string, Endpoint>;
}

export const defineSite = <S extends SiteDef>(site: S): S => site;

/**
 * Typed endpoint helper. Two arguments on purpose: the schemas in the first fix the types before TypeScript checks
 * the strategies in the second, so `request: (input) => …` and `parse` are fully typed without annotations.
 */
export const endpoint = <IS extends ZodType, OS extends ZodType>(
  schemas: Pick<Endpoint<IS, OS>, "input" | "output" | "description">,
  rest: Omit<Endpoint<IS, OS>, "input" | "output" | "description">,
): Endpoint => ({ ...schemas, ...rest }) as unknown as Endpoint;
