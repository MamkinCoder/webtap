import type { Page, Stagehand, StagehandBrowser } from "@browserbasehq/stagehand";
import type { ZodType } from "zod";
import { type ActOptions, type ActResult, type BrowserOptions, type BrowserSession, type Cookie, type Observed, type PageFetchResult } from "../types.js";
import { ActionCache } from "./cache.js";
export interface SessionDeps {
    stagehand: Stagehand;
    browser: StagehandBrowser;
    page: Page;
    opts: BrowserOptions;
    cache: ActionCache;
    /** Extra teardown (asset blocker socket, temp cache dir …). Runs after the browser is closed. */
    cleanup: (() => Promise<void> | void)[];
    /** Browser-level CDP websocket, for extra raw CDP clients (recorder, URL blocker). */
    cdpUrl?: string;
}
export declare const RESOLVE_JS = "(function(sel){\n  if (sel.startsWith(\"xpath=\")) sel = sel.slice(6);\n  if (sel.startsWith(\"/\") || sel.startsWith(\"(\")) return document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;\n  return document.querySelector(sel);\n})";
export declare const fillJs: (selector: string, value: string) => string;
export declare const coveredClickJs: (selector: string) => string;
export declare const pageFetchJs: (url: string, init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => string;
export declare const TEXT_JS: (max: number) => string;
export declare class StagehandSession implements BrowserSession {
    private readonly d;
    private closing;
    private mouse;
    constructor(d: SessionDeps);
    private get page();
    private get actionTimeout();
    goto(url: string, opts?: {
        quick?: boolean;
    }): Promise<void>;
    url(): Promise<string>;
    cdpUrl(): string | undefined;
    html(): Promise<string>;
    text(maxChars?: number): Promise<string>;
    act(instruction: string, opts?: ActOptions): Promise<ActResult>;
    private observeAndRun;
    /** Deterministic Stagehand act on a known Action: xpath resolution + method dispatch, `%var%` substitution, no LLM. */
    private replay;
    private observeRaw;
    extract<T>(instruction: string, schema: ZodType<T>, opts?: {
        timeoutMs?: number;
    }): Promise<T>;
    observe(instruction: string): Promise<Observed[]>;
    fetch(url: string, init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    }): Promise<PageFetchResult>;
    exists(selector: string): Promise<boolean>;
    click(selector: string): Promise<void>;
    fill(selector: string, value: string): Promise<void>;
    upload(selector: string, filePath: string): Promise<void>;
    waitForText(text: string, timeoutMs: number): Promise<boolean>;
    waitForSelector(selector: string, timeoutMs: number): Promise<boolean>;
    evaluate<T = unknown>(js: string): Promise<T>;
    /** An eased curve (one random control point off the straight line), 12-40 trusted mouseMoved events. */
    private moveMouse;
    private box;
    humanize(targets: string[], ms: number): Promise<void>;
    retype(selector: string): Promise<boolean>;
    pressEscape(): Promise<void>;
    pressKey(key: string): Promise<void>;
    snapshot(name: string): Promise<string>;
    cookies(): Promise<Cookie[]>;
    setCookies(cookies: Cookie[]): Promise<void>;
    memoryMB(): Promise<number>;
    close(): Promise<void>;
}
