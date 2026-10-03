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
    /** A url that gives the proxy a new exit IP (mobile proxies have one). Called on a ban instead of a long quarantine. */
    rotateUrl?: string;
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
    canary?: {
        input: z.input<IS>;
        check?: (output: z.output<OS>) => string | null;
    };
    /** Whole call budget across strategies. Default 60000. */
    timeoutMs?: number;
}
export interface SiteDef {
    id: string;
    /** e.g. "https://www.wildberries.ru": relative strategy urls resolve against it. */
    origin: string;
    description?: string;
    /** Per identity: at most one request every minIntervalMs to this site. Default 1000. */
    rateLimit?: {
        minIntervalMs?: number;
        maxConcurrent?: number;
    };
    /** Only identities with a proxy may call this site (it has banned this machine's own IP, or soon would). */
    requireProxy?: boolean;
    /** First quarantine of an identity after a ban; doubles on repeats (max 6 h). Default 10 min. */
    banCooldownMs?: number;
    /** Browser settings for this site's sessions. */
    browser?: {
        /** "stagehand" (default): act/extract/observe with an LLM. "clean": a plain Chrome driven without in-page
         * instrumentation, for sites that ban automated browsers (goto + evaluate + fetch only). */
        engine?: "stagehand" | "clean";
        blockAssets?: boolean;
        loadImages?: boolean;
        headless?: boolean;
        /** URL patterns (Network.setBlockedURLs) never loaded, e.g. ad networks and video: less traffic through a proxy. */
        blockUrls?: string[];
        /** Keep this site's sessions open for good (no idle close), open them at startup (webtap.warm()) and revisit the
         * site's page when idle so cookies stay fresh. Costs one Chrome per identity; saves the cold start and the
         * site's challenge on every call. */
        keepWarm?: {
            everyMs?: number;
            url?: string;
        };
    };
    endpoints: Record<string, Endpoint>;
}
export declare const defineSite: <S extends SiteDef>(site: S) => S;
/**
 * Typed endpoint helper. Two arguments on purpose: the schemas in the first fix the types before TypeScript checks
 * the strategies in the second, so `request: (input) => …` and `parse` are fully typed without annotations.
 */
export declare const endpoint: <IS extends ZodType, OS extends ZodType>(schemas: Pick<Endpoint<IS, OS>, "input" | "output" | "description">, rest: Omit<Endpoint<IS, OS>, "input" | "output" | "description">) => Endpoint;
