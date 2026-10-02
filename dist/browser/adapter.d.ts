import type { ClientLLM } from "@browserbasehq/stagehand";
import type { WebtapLLM } from "../types.js";
type StagehandGenerate = ClientLLM["generate"];
export declare function adaptLLM(llm: WebtapLLM): StagehandGenerate;
export {};
