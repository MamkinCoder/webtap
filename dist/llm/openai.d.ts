import type { WebtapLLM } from "../types.js";
export interface OpenAICompatibleOptions {
    /** e.g. "https://api.openai.com/v1" (the "/chat/completions" path is appended). */
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Concurrent requests. Default 4. */
    concurrency?: number;
    /** Default 120000. */
    timeoutMs?: number;
    /** Send response_format json_object for json_schema requests. Default true; turn off for servers that reject it. */
    jsonMode?: boolean;
}
export declare function openaiCompatible(opts: OpenAICompatibleOptions): WebtapLLM;
