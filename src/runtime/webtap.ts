// The runtime: call(site, endpoint, input) → validated output, however it had to be fetched.
//
// For each strategy in order (skipping ones whose breaker is open):
//   lease an identity with a free rate-limit slot → run → validate (schema + verify)
//     ok      → done
//     banned  → quarantine that identity for this site, retry the same strategy on another identity
//     changed → next strategy (the recipe, not the identity, is the problem)
//     error   → retry once (on another identity when there is one), then next strategy
// changed/error feed the per-strategy circuit breaker; everything feeds health().
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { z } from "zod";
import { ActionCache } from "../browser/cache.js";
import { createLauncher } from "../browser/launcher.js";
import { errMessage, type BrowserLauncher, type BrowserSession, type WebtapLLM } from "../types.js";
import { BrowserPool, type Lease } from "./browser-pool.js";
import { Breaker, Stats, type BreakerOptions, type CanaryResult, type EndpointHealth } from "./health.js";
import { IdentityPool, type IdentitySiteStatus } from "./identity.js";
import { StrategyFailure, changed, type Outcome } from "./outcome.js";
import type { Endpoint, HttpRequest, HttpResponse, Identity, SiteDef, StrategyContext } from "./site.js";
import { encodeBody } from "./strategies.js";

export interface WebtapOptions {
  sites: SiteDef[];
  /** Default: one identity, this machine's own IP. */
  identities?: Identity[];
  /** Needed for browser strategies that act on a cache miss, observe or extract. http / page-fetch work without. */
  llm?: WebtapLLM;
  /** Profiles, action cache, snapshots. Default ".webtap". */
  dataDir?: string;
  browser?: {
    /** Default true. */
    headless?: boolean;
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
}

export interface Attempt {
  strategy: string;
  identity?: string;
  outcome: Outcome | "skipped";
  message?: string;
  ms: number;
}

export type WebtapEvent =
  | ({ type: "attempt"; site: string; endpoint: string } & Attempt)
  | { type: "call"; site: string; endpoint: string; ok: boolean; strategy?: string; ms: number; message?: string };

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

export class WebtapError extends Error {
  constructor(
    public readonly code: WebtapErrorCode,
    message: string,
    public readonly attempts: Attempt[] = [],
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WebtapError";
  }
}

export interface EndpointInfo {
  site: string;
  endpoint: string;
  description?: string;
  input: unknown; // JSON Schema
  output: unknown; // JSON Schema
  strategies: { name: string; kind: string }[];
}

export interface HealthReport {
  sites: Record<string, Record<string, EndpointHealth>>;
  identities: IdentitySiteStatus[];
  browserSessions: number;
}

export interface Webtap {
  call<O = unknown>(site: string, endpoint: string, input: unknown, opts?: { strategy?: string }): Promise<CallResult<O>>;
  /** Endpoint catalog with JSON Schemas: feed it to an LLM as tools, or render docs. */
  describe(): EndpointInfo[];
  health(): HealthReport;
  /** Runs every endpoint's canary (or only `site`'s). perStrategy: test each strategy alone instead of the fallback chain. */
  runCanaries(opts?: { site?: string; perStrategy?: boolean }): Promise<Record<string, CanaryResult>>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_BAN_COOLDOWN_MS = 10 * 60_000;
const BROWSER_BROKEN = /target closed|session closed|browser has been closed|disconnected|websocket|crash|ECONNREFUSED/i;
const FALLBACK_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export function createWebtap(opts: WebtapOptions): Webtap {
  const sites = new Map<string, SiteDef>();
  for (const s of opts.sites) {
    if (sites.has(s.id)) throw new Error(`webtap: duplicate site id ${s.id}`);
    sites.set(s.id, s);
  }
  const dataDir = opts.dataDir ?? ".webtap";
  const identities = new IdentityPool(opts.identities?.length ? opts.identities : [{ id: "direct" }]);
  const breaker = new Breaker(opts.breaker);
  const stats = new Stats();
  const cache = new ActionCache(join(dataDir, "action-cache"));
  const pool = new BrowserPool({
    launcher: opts.launcher ?? createLauncher(opts.llm),
    dataDir,
    cache,
    headless: opts.browser?.headless ?? true,
    ...(opts.browser?.executablePath ? { executablePath: opts.browser.executablePath } : {}),
    ...(opts.browser?.maxSessions ? { maxSessions: opts.browser.maxSessions } : {}),
    ...(opts.browser?.idleMs ? { idleMs: opts.browser.idleMs } : {}),
  });
  const siteGates = new Map<string, Gate>();
  const dispatchers = new Map<string, Dispatcher>();
  const maxIdentityAttempts = Math.max(1, opts.maxIdentityAttempts ?? 3);
  const maxWaitMs = opts.maxWaitMs ?? 15_000;
  const emit = (e: WebtapEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // a broken listener must not break calls
    }
  };

  const gateFor = (site: SiteDef): Gate => {
    let g = siteGates.get(site.id);
    if (!g) {
      g = new Gate(site.rateLimit?.maxConcurrent ?? Infinity);
      siteGates.set(site.id, g);
    }
    return g;
  };

  const dispatcherFor = (identity: Identity): Dispatcher | undefined => {
    if (!identity.proxy) return undefined;
    let d = dispatchers.get(identity.id);
    if (!d) {
      const { server, username, password } = identity.proxy;
      d = new ProxyAgent({
        uri: server,
        ...(username ? { token: `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}` } : {}),
      });
      dispatchers.set(identity.id, d);
    }
    return d;
  };

  const httpFetch = async (site: SiteDef, identity: Identity, req: HttpRequest, signal: AbortSignal): Promise<HttpResponse> => {
    const { body, headers } = encodeBody(req);
    const dispatcher = dispatcherFor(identity);
    const res = await undiciFetch(new URL(req.url, site.origin), {
      method: req.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "user-agent": identity.userAgent ?? FALLBACK_UA,
        "accept-language": (identity.languages ?? ["ru-RU", "ru", "en-US", "en"]).join(","),
        accept: "application/json, text/plain, */*",
        ...headers,
      },
      ...(body !== undefined ? { body } : {}),
      ...(dispatcher ? { dispatcher } : {}),
      signal,
    }).catch((err: unknown) => {
      throw new StrategyFailure("error", `network: ${errMessage((err as { cause?: unknown })?.cause ?? err)}`);
    });
    return { status: res.status, url: res.url, contentType: res.headers.get("content-type") ?? "", body: await res.text() };
  };

  const lookup = (siteId: string, endpointName: string): { site: SiteDef; ep: Endpoint } => {
    const site = sites.get(siteId);
    if (!site) throw new WebtapError("unknown_site", `unknown site: ${siteId}`);
    const ep = site.endpoints[endpointName];
    if (!ep) throw new WebtapError("unknown_endpoint", `unknown endpoint: ${siteId}/${endpointName}`);
    return { site, ep };
  };

  async function call<O>(siteId: string, endpointName: string, rawInput: unknown, callOpts: { strategy?: string } = {}): Promise<CallResult<O>> {
    const { site, ep } = lookup(siteId, endpointName);
    const parsed = ep.input.safeParse(rawInput);
    if (!parsed.success) throw new WebtapError("bad_input", `bad input for ${siteId}/${endpointName}: ${parsed.error.message}`, [], parsed.error.issues);
    const input = parsed.data;
    const strategies = callOpts.strategy ? ep.strategies.filter((s) => s.name === callOpts.strategy) : ep.strategies;
    if (!strategies.length) throw new WebtapError("unknown_endpoint", `no strategy ${callOpts.strategy} on ${siteId}/${endpointName}`);

    const started = Date.now();
    const signal = AbortSignal.timeout(ep.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const attempts: Attempt[] = [];
    const minIntervalMs = site.rateLimit?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const banCooldownMs = site.banCooldownMs ?? DEFAULT_BAN_COOLDOWN_MS;
    const record = (a: Attempt) => {
      attempts.push(a);
      emit({ type: "attempt", site: site.id, endpoint: endpointName, ...a });
    };

    const result = await gateFor(site).run(async () => {
      for (const [index, strategy] of strategies.entries()) {
        const bkey = `${site.id}/${endpointName}/${strategy.name}`;
        // A forced strategy (canaries, debugging) ignores the breaker: that is how it gets tested again.
        if (!callOpts.strategy && !breaker.allow(bkey)) {
          record({ strategy: strategy.name, outcome: "skipped", message: "circuit open", ms: 0 });
          continue;
        }
        const tried = new Set<string>();
        let errors = 0;
        for (let i = 0; i < maxIdentityAttempts && !signal.aborted; i++) {
          const identity = await identities.acquire(site.id, { minIntervalMs, exclude: tried, maxWaitMs, signal }).catch(() => null);
          if (!identity) {
            const why = identities.allQuarantined(site.id) ? "every identity is quarantined for this site" : tried.size ? "no other identity available" : "rate limited";
            record({ strategy: strategy.name, outcome: "skipped", message: why, ms: 0 });
            break;
          }
          tried.add(identity.id);
          const t0 = Date.now();
          let lease: Lease | undefined;
          let outcome: Outcome = "error";
          let message = "";
          try {
            const ctx: StrategyContext = {
              site,
              identity,
              signal,
              fetch: (req) => httpFetch(site, identity, req, signal),
              session: async (): Promise<BrowserSession> => {
                lease ??= await pool.lease(identity, site, signal);
                return lease.session;
              },
            };
            const raw = await raceSignal(strategy.run(ctx, input), signal);
            const out = ep.output.safeParse(raw);
            if (!out.success) throw changed(`output does not match the schema: ${out.error.message.slice(0, 300)}`);
            const bad = ep.verify?.(out.data, input);
            if (bad) throw changed(`verify: ${bad}`);
            outcome = "ok";
            const ms = Date.now() - t0;
            identities.report(site.id, identity.id, "ok", banCooldownMs);
            breaker.success(bkey);
            stats.attempt(site.id, endpointName, strategy.name, "ok", ms);
            record({ strategy: strategy.name, identity: identity.id, outcome: "ok", ms });
            return { data: out.data as O, strategy: strategy.name, identity: identity.id, primary: index === 0 };
          } catch (err) {
            const f = err instanceof StrategyFailure ? err : new StrategyFailure("error", signal.aborted ? "call timed out" : errMessage(err));
            outcome = f.outcome;
            message = f.message;
          } finally {
            // A crashed or wedged browser is not trusted warm; any other failure keeps the session (and its solved
            // challenge) for the next call.
            await lease?.release(outcome === "error" && (signal.aborted || BROWSER_BROKEN.test(message)));
          }
          const ms = Date.now() - t0;
          identities.report(site.id, identity.id, outcome, banCooldownMs);
          stats.attempt(site.id, endpointName, strategy.name, outcome, ms, message);
          record({ strategy: strategy.name, identity: identity.id, outcome, message, ms });
          if (outcome === "changed") {
            breaker.failure(bkey);
            break;
          }
          if (outcome === "error" && ++errors >= 2) {
            breaker.failure(bkey);
            break;
          }
          // A first transient error may retry on the same identity (after its rate-limit gap) when it is the only one
          // left; a ban never does.
          if (outcome === "error" && identities.identities.every((x) => tried.has(x.id))) tried.delete(identity.id);
          // banned (or a first error): same strategy, another identity when there is one
        }
      }
      return undefined;
    });

    const ms = Date.now() - started;
    if (!result) {
      const message = summarize(attempts);
      stats.call(site.id, endpointName, false, false, undefined, message);
      emit({ type: "call", site: site.id, endpoint: endpointName, ok: false, ms, message });
      throw new WebtapError("failed", `${site.id}/${endpointName} failed: ${message}`, attempts);
    }
    stats.call(site.id, endpointName, true, result.primary, result.strategy);
    emit({ type: "call", site: site.id, endpoint: endpointName, ok: true, strategy: result.strategy, ms });
    return { data: result.data, site: site.id, endpoint: endpointName, strategy: result.strategy, identity: result.identity, ms, attempts };
  }

  return {
    call,

    describe() {
      const out: EndpointInfo[] = [];
      for (const site of sites.values()) {
        for (const [name, ep] of Object.entries(site.endpoints)) {
          out.push({
            site: site.id,
            endpoint: name,
            ...(ep.description ? { description: ep.description } : {}),
            input: toJsonSchema(ep.input, "input"),
            output: toJsonSchema(ep.output, "output"),
            strategies: ep.strategies.map((s) => ({ name: s.name, kind: s.kind })),
          });
        }
      }
      return out;
    },

    health() {
      const report: HealthReport = { sites: {}, identities: identities.status(), browserSessions: pool.size };
      for (const site of sites.values()) {
        const eps: Record<string, EndpointHealth> = {};
        for (const name of Object.keys(site.endpoints)) {
          eps[name] = stats.snapshot(site.id, name, (strategy) => breaker.isOpen(`${site.id}/${name}/${strategy}`));
        }
        report.sites[site.id] = eps;
      }
      return report;
    },

    async runCanaries(o = {}) {
      const results: Record<string, CanaryResult> = {};
      for (const site of sites.values()) {
        if (o.site && site.id !== o.site) continue;
        for (const [name, ep] of Object.entries(site.endpoints)) {
          if (!ep.canary) continue;
          const runs = o.perStrategy ? ep.strategies.map((s) => s.name) : [undefined];
          for (const strategy of runs) {
            const key = `${site.id}/${name}${strategy ? `#${strategy}` : ""}`;
            const t0 = Date.now();
            let r: CanaryResult;
            try {
              const res = await call(site.id, name, ep.canary.input, strategy ? { strategy } : {});
              const bad = (ep.canary.check ?? defaultCanaryCheck)(res.data);
              r = { at: new Date().toISOString(), ok: !bad, strategy: res.strategy, ms: Date.now() - t0, ...(bad ? { message: bad } : {}) };
            } catch (err) {
              r = { at: new Date().toISOString(), ok: false, message: errMessage(err), ms: Date.now() - t0, ...(strategy ? { strategy } : {}) };
            }
            if (!strategy) stats.canary(site.id, name, r);
            results[key] = r;
          }
        }
      }
      return results;
    },

    async close() {
      await pool.close();
      await Promise.allSettled([...dispatchers.values()].map((d) => d.close()));
    },
  };
}

/** "At least one item": passes when the first array found in the output (depth-first) is non-empty. */
export function defaultCanaryCheck(output: unknown): string | null {
  const arr = firstArray(output, 0);
  if (arr === undefined) return null;
  return arr.length ? null : "empty result";
}

function firstArray(v: unknown, depth: number): unknown[] | undefined {
  if (Array.isArray(v)) return v;
  if (depth > 3 || typeof v !== "object" || v === null) return undefined;
  for (const x of Object.values(v)) {
    const a = firstArray(x, depth + 1);
    if (a) return a;
  }
  return undefined;
}

function summarize(attempts: Attempt[]): string {
  if (!attempts.length) return "no strategy ran";
  return attempts.map((a) => `${a.strategy}${a.identity ? `@${a.identity}` : ""}: ${a.outcome}${a.message ? ` (${a.message})` : ""}`).join("; ");
}

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" });
  } catch {
    return {};
  }
}

/** Rejects when the call's budget runs out, even if the strategy ignores the signal (a wedged page). */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new StrategyFailure("error", "call timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new StrategyFailure("error", "call timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Per-site concurrency cap (maxConcurrent). */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
