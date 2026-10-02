import type { WebtapLLM } from "../types.js";
export interface ClaudeCliOptions {
    /** Default "claude". */
    bin?: string;
    /** Default "haiku": picking an element is classification. */
    model?: string;
    /** Concurrent processes. Default 1. */
    concurrency?: number;
    /** Default 120000. */
    timeoutMs?: number;
    cwd?: string;
    env?: Record<string, string>;
}
interface ClaudeFeatures {
    jsonSchema: boolean;
    maxTurns: boolean;
    noSessionPersistence: boolean;
    tools: boolean;
}
export declare function buildArgs(model: string, f: ClaudeFeatures, schema?: unknown): string[];
/** `--output-format json` prints one result object (older builds: an array ending with it). */
export declare function parseEnvelope(stdout: string): {
    text: string;
    structured?: unknown;
    isError: boolean;
};
export declare function claudeCli(opts?: ClaudeCliOptions): WebtapLLM;
export {};
