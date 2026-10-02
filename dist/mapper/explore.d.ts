import { type BrowserSession, type WebtapLLM } from "../types.js";
import type { InputValue } from "./analyze.js";
export interface ExploreStep {
    kind: "act" | "goto";
    /** act: instruction with %input% placeholders; goto: url. */
    value: string;
    ok: boolean;
    message: string;
}
export interface ExploreResult {
    steps: ExploreStep[];
    done: boolean;
    /** The site put up a captcha / anti-bot wall. */
    blocked?: string;
    summary: string;
}
/** %name% → value (URI-encoded inside urls). */
export declare function fillPlaceholders(s: string, vars: Record<string, string>, uri: boolean): string;
export declare function explore(s: BrowserSession, llm: WebtapLLM, o: {
    goal: string;
    inputs: Record<string, InputValue>;
    maxSteps?: number;
    log?: (msg: string) => void;
}): Promise<ExploreResult>;
