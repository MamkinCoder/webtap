import type { Outcome } from "./outcome.js";
export interface BreakerOptions {
    /** Consecutive changed/error failures that open the breaker. Default 3. */
    threshold?: number;
    /** How long an open breaker skips the strategy. Default 60000. */
    cooldownMs?: number;
}
export declare class Breaker {
    private readonly now;
    private readonly state;
    private readonly threshold;
    private readonly cooldownMs;
    constructor(o?: BreakerOptions, now?: () => number);
    /** Open breakers allow nothing until the cooldown ends; then one trial call (a failure reopens it at once). */
    allow(key: string): boolean;
    isOpen(key: string): boolean;
    success(key: string): void;
    failure(key: string): void;
}
export interface StrategyStats {
    ok: number;
    banned: number;
    changed: number;
    error: number;
    /** Moving average of successful attempts. */
    avgMs: number;
    lastOkAt?: string;
    lastFailure?: {
        at: string;
        outcome: Exclude<Outcome, "ok">;
        message: string;
    };
    breakerOpen: boolean;
}
export type EndpointStatus = "ok" | "degraded" | "down" | "unknown";
export interface CanaryResult {
    at: string;
    ok: boolean;
    strategy?: string;
    message?: string;
    ms: number;
}
export interface EndpointHealth {
    /** ok: the last call succeeded on the first strategy; degraded: it needed a fallback; down: it failed. */
    status: EndpointStatus;
    calls: number;
    failures: number;
    lastCall?: {
        at: string;
        ok: boolean;
        strategy?: string;
        message?: string;
    };
    canary?: CanaryResult;
    strategies: Record<string, StrategyStats>;
}
export declare class Stats {
    private readonly now;
    private readonly endpoints;
    constructor(now?: () => number);
    private ep;
    attempt(site: string, endpoint: string, strategy: string, outcome: Outcome, ms: number, message?: string): void;
    call(site: string, endpoint: string, ok: boolean, primary: boolean, strategy?: string, message?: string): void;
    canary(site: string, endpoint: string, r: CanaryResult): void;
    snapshot(site: string, endpoint: string, breakerOpen: (strategy: string) => boolean): EndpointHealth;
}
