import type { BrowserSession } from "../types.js";
import type { HttpRequest, Strategy, StrategyContext } from "./site.js";
export interface HttpStrategyOptions<I, O> {
    name?: string;
    /** ctx gives the identity, e.g. for a per-identity device id. */
    request: (input: I, ctx: StrategyContext) => HttpRequest;
    /** Maps the JSON body to the endpoint's output. Throwing = the response shape changed. */
    parse: (json: any, input: I) => O;
}
export declare function http<I, O>(o: HttpStrategyOptions<I, O>): Strategy<I, O>;
export interface PageFetchStrategyOptions<I, O> {
    name?: string;
    /** A page of the site to open first, so its scripts set cookies / solve the anti-bot challenge. */
    warmUrl: string;
    request: (input: I, ctx: StrategyContext) => HttpRequest;
    parse: (json: any, input: I) => O;
    /** Wait after opening warmUrl for challenge scripts to finish. Default 3000. */
    settleMs?: number;
}
export declare function pageFetch<I, O>(o: PageFetchStrategyOptions<I, O>): Strategy<I, O>;
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
export declare function requests<I, O>(o: RequestsStrategyOptions<I, O>): Strategy<I, O>;
export interface BrowserStrategyOptions<I, O> {
    name?: string;
    /** Drive the page: goto, act (cached + healed), extract. Throw changed()/banned() when you can tell. */
    run: (s: BrowserSession, input: I, ctx: StrategyContext) => Promise<O>;
}
export declare function browser<I, O>(o: BrowserStrategyOptions<I, O>): Strategy<I, O>;
/** A string body is sent as is; anything else as JSON. */
export declare function encodeBody(req: HttpRequest): {
    body: string | undefined;
    headers: Record<string, string>;
};
