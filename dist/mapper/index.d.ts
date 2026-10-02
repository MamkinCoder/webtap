import { type WebtapLLM } from "../types.js";
import { type InputValue } from "./analyze.js";
export interface MapOptions {
    /** Where the explorer starts, e.g. "https://travel.yandex.ru/hotels/". */
    url: string;
    /** What the endpoint does, in words: "find hotels in a city for dates". */
    goal: string;
    /** Sample input values; their names become the endpoint's input fields. */
    inputs: Record<string, InputValue>;
    /** Output item fields: "title,priceRub:number?,url,imageUrl?". */
    fields: string;
    /** Site id (default: the host). */
    id?: string;
    /** Endpoint name. Default "search". */
    endpoint?: string;
    /** Explorer + parse codegen (a strong model helps). */
    llm: WebtapLLM;
    /** Stagehand's observe/extract (a fast model is fine). Default: llm. */
    browserLlm?: WebtapLLM;
    headless?: boolean;
    executablePath?: string;
    maxSteps?: number;
    log?: (msg: string) => void;
}
export interface MapReport {
    explored: {
        steps: number;
        done: boolean;
        summary: string;
    };
    truth: Record<string, unknown>[];
    recorded: number;
    candidates: {
        url: string;
        method: string;
        score: number;
    }[];
    chosen?: {
        url: string;
        method: string;
        http: boolean;
        pageFetch: boolean;
        usedInputs: string[];
        parsedItems: number;
        truthMatched: number;
        chainCalls?: number;
    };
    notes: string[];
}
export interface MapResult {
    /** The site file (TypeScript). */
    source: string;
    report: MapReport;
}
export declare function mapSite(o: MapOptions): Promise<MapResult>;
export { parseFields } from "./codegen.js";
