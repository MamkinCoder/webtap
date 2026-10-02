import type { RecordedExchange } from "../browser/cdp.js";
export type InputValue = string | number;
/** A string part, or a reference to an input (rendered as `i.<name>`). */
export type Part = string | {
    input: string;
    encode: "uri" | "raw";
};
export interface RequestTemplate {
    method: string;
    url: Part[];
    headers: Record<string, string>;
    /** JSON body with inputs substituted, or a raw string body. */
    body?: {
        json: unknown;
    } | {
        text: Part[];
    };
    /** Inputs that actually appear in the request. */
    usedInputs: string[];
}
export interface Candidate {
    exchange: RecordedExchange;
    json: unknown;
    score: number;
    matched: string[];
}
/** JSON responses only, re-serialised so \u escapes and spacing do not hide matches. */
export declare function parseJsonExchange(ex: RecordedExchange): unknown | undefined;
/** Ground-truth strings worth matching: long enough to be specific. */
export declare function truthStrings(items: Record<string, unknown>[]): string[];
/** Ranks JSON responses by how many ground-truth strings they contain. */
export declare function rankCandidates(exchanges: RecordedExchange[], truths: string[]): Candidate[];
export declare function keepHeaders(headers: Record<string, string>): Record<string, string>;
export declare function toTemplate(ex: RecordedExchange, inputs: Record<string, InputValue>): RequestTemplate;
/** Renders a template back into a concrete request for given input values (used to verify it before codegen). */
export declare function fillTemplate(t: RequestTemplate, values: Record<string, InputValue>): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
};
/** A small, representative slice of a JSON value for a prompt: arrays cut to 2 items, long strings cut. */
export declare function pruneJson(v: unknown, depth?: number): unknown;
/** Id-like values in a request's query string and JSON body (numbers ≥ 1000, tokens with digits). */
export declare function requestValues(ex: RecordedExchange, inputs: Record<string, InputValue>): string[];
/** Path to the first primitive equal to `value` (string or number), e.g. "data.items[0].id". */
export declare function findPath(json: unknown, value: string, path?: string, depth?: number): string | undefined;
export interface ChainLink {
    value: string;
    /** Index into chain of the exchange whose response holds the value. */
    from: number;
    path: string;
    /** Index into chain of the exchange whose request uses it. */
    to: number;
}
export interface Chain {
    /** Ordered: first call first, the data request last. */
    exchanges: RecordedExchange[];
    links: ChainLink[];
    /** True when every input appears in some call of the chain. */
    reachesInputs: boolean;
}
export declare function traceChain(main: RecordedExchange, all: RecordedExchange[], inputs: Record<string, InputValue>, maxDepth?: number): Chain;
