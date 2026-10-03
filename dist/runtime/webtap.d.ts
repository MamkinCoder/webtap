import { type BrowserLauncher, type WebtapLLM } from "../types.js";
import { type BreakerOptions, type CanaryResult, type EndpointHealth } from "./health.js";
import { type IdentitySiteStatus } from "./identity.js";
import { type Outcome } from "./outcome.js";
import type { Identity, SiteDef } from "./site.js";
export interface WebtapOptions {
    sites: SiteDef[];
    /** Default: one identity, this machine's own IP. */
    identities?: Identity[];
    /** Needed for browser strategies that act on a cache miss, observe or extract. http / page-fetch work without. */
    llm?: WebtapLLM;
    /** Profiles, action cache, snapshots. Default ".webtap". */
    dataDir?: string;
    browser?: {
        /** Default true. A site can override it (browser.headless: false for sites that block headless Chrome). */
        headless?: boolean;
        /** Headful windows on screen instead of off-screen (debugging). */
        visible?: boolean;
        executablePath?: string;
        /** Concurrent Chromium processes. Default 4. */
        maxSessions?: number;
        idleMs?: number;
    };
    /** Attempts per strategy (identities tried, plus one same-identity retry of a transient error). Default 3. */
    maxIdentityAttempts?: number;
    /** Longest wait for a rate-limit slot before an identity counts as unavailable. Default 15000. */
    maxWaitMs?: number;
    breaker?: BreakerOptions;
    onEvent?: (e: WebtapEvent) => void;
    /** Custom browser launcher (tests, remote browsers). */
    launcher?: BrowserLauncher;
    /** Custom launcher for clean-engine sites. */
    cleanLauncher?: BrowserLauncher;
    /** Pause after rotating a proxy's IP before the call retries on it. Default 15000. */
    rotatePauseMs?: number;
}
export interface Attempt {
    strategy: string;
    identity?: string;
    outcome: Outcome | "skipped";
    message?: string;
    ms: number;
}
export type WebtapEvent = ({
    type: "attempt";
    site: string;
    endpoint: string;
} & Attempt) | {
    type: "call";
    site: string;
    endpoint: string;
    ok: boolean;
    strategy?: string;
    ms: number;
    message?: string;
};
export interface CallResult<O = unknown> {
    data: O;
    site: string;
    endpoint: string;
    strategy: string;
    identity: string;
    ms: number;
    attempts: Attempt[];
}
export type WebtapErrorCode = "unknown_site" | "unknown_endpoint" | "bad_input" | "failed";
export declare class WebtapError extends Error {
    readonly code: WebtapErrorCode;
    readonly attempts: Attempt[];
    readonly details?: unknown | undefined;
    constructor(code: WebtapErrorCode, message: string, attempts?: Attempt[], details?: unknown | undefined);
}
export interface EndpointInfo {
    site: string;
    endpoint: string;
    description?: string;
    input: unknown;
    output: unknown;
    strategies: {
        name: string;
        kind: string;
    }[];
}
export interface HealthReport {
    sites: Record<string, Record<string, EndpointHealth>>;
    identities: IdentitySiteStatus[];
    browserSessions: number;
}
export interface Webtap {
    call<O = unknown>(site: string, endpoint: string, input: unknown, opts?: {
        strategy?: string;
    }): Promise<CallResult<O>>;
    /** Endpoint catalog with JSON Schemas: feed it to an LLM as tools, or render docs. */
    describe(): EndpointInfo[];
    health(): HealthReport;
    /** Runs every endpoint's canary (or only `site`'s). perStrategy: test each strategy alone instead of the fallback chain. */
    runCanaries(opts?: {
        site?: string;
        perStrategy?: boolean;
    }): Promise<Record<string, CanaryResult>>;
    /** Opens the sessions of keepWarm sites now (their primary identity) and starts their keep-alive visits. */
    warm(): Promise<void>;
    close(): Promise<void>;
}
export declare function createWebtap(opts: WebtapOptions): Webtap;
/** "At least one item": passes when the first array found in the output (depth-first) is non-empty. */
export declare function defaultCanaryCheck(output: unknown): string | null;
