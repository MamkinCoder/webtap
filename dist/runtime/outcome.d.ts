import type { HttpResponse } from "./site.js";
export type Outcome = "ok" | "banned" | "changed" | "error";
export declare class StrategyFailure extends Error {
    readonly outcome: Exclude<Outcome, "ok">;
    constructor(outcome: Exclude<Outcome, "ok">, message: string);
}
export declare const banned: (message: string) => StrategyFailure;
export declare const changed: (message: string) => StrategyFailure;
export declare const transient: (message: string) => StrategyFailure;
export declare const looksLikeChallenge: (r: Pick<HttpResponse, "url" | "body">) => boolean;
/** null = a usable response. */
export declare function classifyResponse(r: HttpResponse): StrategyFailure | null;
/** JSON body of a usable response; a challenge page or non-JSON becomes banned / changed. */
export declare function parseJsonBody(r: HttpResponse): unknown;
