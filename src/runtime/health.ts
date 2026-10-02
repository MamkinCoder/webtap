// Circuit breaker and per-strategy stats. A strategy that keeps failing with "changed"/"error" is skipped for a
// cooldown (fail fast, fall through to the next strategy) instead of burning every call's time budget on it.
import type { Outcome } from "./outcome.js";

export interface BreakerOptions {
  /** Consecutive changed/error failures that open the breaker. Default 3. */
  threshold?: number;
  /** How long an open breaker skips the strategy. Default 60000. */
  cooldownMs?: number;
}

export class Breaker {
  private readonly state = new Map<string, { failures: number; openUntil: number }>();
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(
    o: BreakerOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.threshold = o.threshold ?? 3;
    this.cooldownMs = o.cooldownMs ?? 60_000;
  }

  /** Open breakers allow nothing until the cooldown ends; then one trial call (a failure reopens it at once). */
  allow(key: string): boolean {
    const s = this.state.get(key);
    return !s || s.openUntil <= this.now();
  }

  isOpen(key: string): boolean {
    return !this.allow(key);
  }

  success(key: string): void {
    this.state.delete(key);
  }

  failure(key: string): void {
    const s = this.state.get(key) ?? { failures: 0, openUntil: 0 };
    s.failures++;
    if (s.failures >= this.threshold) s.openUntil = this.now() + this.cooldownMs;
    this.state.set(key, s);
  }
}

export interface StrategyStats {
  ok: number;
  banned: number;
  changed: number;
  error: number;
  /** Moving average of successful attempts. */
  avgMs: number;
  lastOkAt?: string;
  lastFailure?: { at: string; outcome: Exclude<Outcome, "ok">; message: string };
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
  lastCall?: { at: string; ok: boolean; strategy?: string; message?: string };
  canary?: CanaryResult;
  strategies: Record<string, StrategyStats>;
}

export class Stats {
  private readonly endpoints = new Map<string, Omit<EndpointHealth, "strategies"> & { strategies: Map<string, Omit<StrategyStats, "breakerOpen">> }>();

  constructor(private readonly now: () => number = Date.now) {}

  private ep(site: string, endpoint: string) {
    const key = `${site}/${endpoint}`;
    let e = this.endpoints.get(key);
    if (!e) {
      e = { status: "unknown", calls: 0, failures: 0, strategies: new Map() };
      this.endpoints.set(key, e);
    }
    return e;
  }

  attempt(site: string, endpoint: string, strategy: string, outcome: Outcome, ms: number, message?: string): void {
    const e = this.ep(site, endpoint);
    let s = e.strategies.get(strategy);
    if (!s) {
      s = { ok: 0, banned: 0, changed: 0, error: 0, avgMs: 0 };
      e.strategies.set(strategy, s);
    }
    s[outcome]++;
    const at = new Date(this.now()).toISOString();
    if (outcome === "ok") {
      s.avgMs = s.ok === 1 ? ms : Math.round(s.avgMs * 0.8 + ms * 0.2);
      s.lastOkAt = at;
    } else {
      s.lastFailure = { at, outcome, message: message ?? "" };
    }
  }

  call(site: string, endpoint: string, ok: boolean, primary: boolean, strategy?: string, message?: string): void {
    const e = this.ep(site, endpoint);
    e.calls++;
    if (!ok) e.failures++;
    e.status = !ok ? "down" : primary ? "ok" : "degraded";
    e.lastCall = { at: new Date(this.now()).toISOString(), ok, ...(strategy ? { strategy } : {}), ...(message ? { message } : {}) };
  }

  canary(site: string, endpoint: string, r: CanaryResult): void {
    this.ep(site, endpoint).canary = r;
  }

  snapshot(site: string, endpoint: string, breakerOpen: (strategy: string) => boolean): EndpointHealth {
    const e = this.ep(site, endpoint);
    const strategies: Record<string, StrategyStats> = {};
    for (const [name, s] of e.strategies) strategies[name] = { ...s, breakerOpen: breakerOpen(name) };
    const { strategies: _s, ...rest } = e;
    return { ...rest, strategies };
  }
}
