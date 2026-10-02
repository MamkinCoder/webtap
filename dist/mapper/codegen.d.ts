import { z } from "zod";
import type { WebtapLLM } from "../types.js";
import { type Chain, type InputValue, type RequestTemplate } from "./analyze.js";
export interface FieldSpec {
    name: string;
    type: "string" | "number" | "boolean";
    optional: boolean;
}
/** "title:string,priceRub:number?,url" → specs (type defaults to string, "?" = optional). */
export declare function parseFields(spec: string): FieldSpec[];
export declare function itemSchema(fields: FieldSpec[]): z.ZodObject;
export interface ParseGenInput {
    goal: string;
    origin: string;
    fields: FieldSpec[];
    json: unknown;
    /** Items as the page showed them (strings), to check the mapping against. */
    truth: Record<string, unknown>[];
    input: Record<string, InputValue>;
}
export interface ParseGenResult {
    code: string;
    items: Record<string, unknown>[];
    /** How many ground-truth titles the parsed items reproduce. */
    truthMatched: number;
}
/** Compiles an arrow function from source. The code is the mapper's own LLM output, run locally on recorded data. */
export declare function compileParse(code: string): (json: unknown, input: unknown) => {
    items?: unknown[];
};
/** Asks the LLM for a parse function and checks it on the recorded response; feeds errors back, up to `attempts`. */
export declare function generateParse(llm: WebtapLLM, g: ParseGenInput, attempts?: number): Promise<ParseGenResult>;
export declare const truthInstruction: (fields: FieldSpec[]) => string;
export type ChainFetch = (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
}) => Promise<unknown>;
export interface ChainGenInput {
    goal: string;
    origin: string;
    fields: FieldSpec[];
    chain: Chain;
    truth: Record<string, unknown>[];
    input: Record<string, InputValue>;
    /** Runs the generated code's requests for real (HTTP or inside the tab) during validation. */
    fetchJson: ChainFetch;
}
/** Describes the recorded calls and how values flowed between them, for the prompt and the file's comment. */
export declare function describeChain(chain: Chain): string[];
/** Compiles an async arrow function from source (the mapper's own LLM output). */
export declare function compileChain(code: string): (input: unknown, fetchJson: ChainFetch) => Promise<{
    items?: unknown[];
}>;
/** Asks the LLM to wire the recorded call chain; runs it for real and checks it reproduces the page. */
export declare function generateChain(llm: WebtapLLM, g: ChainGenInput, attempts?: number): Promise<ParseGenResult>;
/**
 * Makes LLM-written JavaScript pass strict TypeScript: plain parameters of arrow functions and function expressions
 * get `: any` (`o => …` → `(o: any) => …`, `(a, b) =>` → `(a: any, b: any) =>`). Destructured, defaulted and rest
 * parameters are left alone. Validation runs the original JavaScript; only the rendered file is annotated.
 */
export declare function annotateAny(code: string): string;
export interface RenderInput {
    id: string;
    endpoint: string;
    goal: string;
    origin: string;
    startUrl: string;
    inputs: Record<string, InputValue>;
    fields: FieldSpec[];
    /** The recorded data request, when one was found and verified. */
    request?: {
        template: RequestTemplate;
        http: boolean;
        pageFetch: boolean;
        parseCode: string;
        recordedUrl: string;
    };
    /** Or a recorded chain of calls (suggest → id → search → details), wired by the LLM and run for real. */
    chain?: {
        code: string;
        http: boolean;
        pageFetch: boolean;
        calls: string[];
    };
    /** act() instructions the explorer used, with %input% placeholders. */
    steps: {
        kind: "act" | "goto";
        value: string;
    }[];
    date: string;
    notes: string[];
}
export declare function renderSite(r: RenderInput): string;
