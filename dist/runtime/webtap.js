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
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { z } from "zod";
import { ActionCache } from "../browser/cache.js";
import { createCleanLauncher } from "../browser/clean.js";
import { createLauncher } from "../browser/launcher.js";
import { errMessage } from "../types.js";
import { BrowserPool } from "./browser-pool.js";
import { Breaker, Stats } from "./health.js";
import { IdentityPool } from "./identity.js";
import { StrategyFailure, changed } from "./outcome.js";
import { browserHeaders } from "./fingerprint.js";
import { encodeBody } from "./strategies.js";
export class WebtapError extends Error {
    code;
    attempts;
    details;
    constructor(code, message, attempts = [], details) {
        super(message);
        this.code = code;
        this.attempts = attempts;
        this.details = details;
        this.name = "WebtapError";
    }
}
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_BAN_COOLDOWN_MS = 10 * 60_000;
const ROTATE_PAUSE_MS = 15_000;
const KEEP_WARM_EVERY_MS = 4 * 60_000;
/** Calls a proxy's IP-change url; true when it answered 2xx. */
async function rotateIp(url) {
    try {
        const res = await undiciFetch(url, { signal: AbortSignal.timeout(60_000) });
        await res.text();
        if (!res.ok)
            return false;
        await new Promise((r) => setTimeout(r, 5_000)); // the modem reconnects
        return true;
    }
    catch {
        return false;
    }
}
// "connection closed": the clean engine's CDP socket (Chrome died, a remote browser restarted); "session with given
// id": its tab was closed under it (wipeRemoteBrowser).
const BROWSER_BROKEN = /target closed|session closed|browser has been closed|disconnected|websocket|crash|ECONNREFUSED|connection closed|session with given id/i;
export function createWebtap(opts) {
    const sites = new Map();
    for (const s of opts.sites) {
        if (sites.has(s.id))
            throw new Error(`webtap: duplicate site id ${s.id}`);
        sites.set(s.id, s);
    }
    const dataDir = opts.dataDir ?? ".webtap";
    const identities = new IdentityPool(opts.identities?.length ? opts.identities : [{ id: "direct" }]);
    const breaker = new Breaker(opts.breaker);
    const stats = new Stats();
    const cache = new ActionCache(join(dataDir, "action-cache"));
    const pool = new BrowserPool({
        launcher: opts.launcher ?? createLauncher(opts.llm),
        cleanLauncher: opts.cleanLauncher ?? createCleanLauncher(),
        dataDir,
        cache,
        headless: opts.browser?.headless ?? true,
        ...(opts.browser?.visible ? { visible: true } : {}),
        ...(opts.browser?.executablePath ? { executablePath: opts.browser.executablePath } : {}),
        ...(opts.browser?.maxSessions ? { maxSessions: opts.browser.maxSessions } : {}),
        ...(opts.browser?.idleMs ? { idleMs: opts.browser.idleMs } : {}),
    });
    const siteGates = new Map();
    const dispatchers = new Map();
    const maxIdentityAttempts = Math.max(1, opts.maxIdentityAttempts ?? 3);
    const rotatePauseMs = opts.rotatePauseMs ?? ROTATE_PAUSE_MS;
    // A call that rotated must be able to wait out the reconnect pause for its retry.
    const maxWaitMs = Math.max(opts.maxWaitMs ?? 15_000, rotatePauseMs + 1_000);
    const emit = (e) => {
        try {
            opts.onEvent?.(e);
        }
        catch {
            // a broken listener must not break calls
        }
    };
    const gateFor = (site) => {
        let g = siteGates.get(site.id);
        if (!g) {
            g = new Gate(site.rateLimit?.maxConcurrent ?? Infinity);
            siteGates.set(site.id, g);
        }
        return g;
    };
    const dispatcherFor = (identity) => {
        if (!identity.proxy)
            return undefined;
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
    const httpFetch = async (site, identity, req, signal) => {
        const { body, headers } = encodeBody(req);
        const dispatcher = dispatcherFor(identity);
        const url = new URL(req.url, site.origin);
        const method = req.method ?? (body === undefined ? "GET" : "POST");
        // A coherent Chrome (UA + client hints + fetch metadata); the recipe's own headers win.
        const merged = { ...browserHeaders(identity, site, url, method) };
        for (const [k, v] of Object.entries(headers))
            merged[k.toLowerCase()] = v;
        const res = await undiciFetch(url, {
            method,
            headers: merged,
            ...(body !== undefined ? { body } : {}),
            ...(dispatcher ? { dispatcher } : {}),
            signal,
        }).catch((err) => {
            throw new StrategyFailure("error", `network: ${errMessage(err?.cause ?? err)}`);
        });
        return { status: res.status, url: res.url, contentType: res.headers.get("content-type") ?? "", body: await res.text() };
    };
    const lookup = (siteId, endpointName) => {
        const site = sites.get(siteId);
        if (!site)
            throw new WebtapError("unknown_site", `unknown site: ${siteId}`);
        const ep = site.endpoints[endpointName];
        if (!ep)
            throw new WebtapError("unknown_endpoint", `unknown endpoint: ${siteId}/${endpointName}`);
        return { site, ep };
    };
    async function call(siteId, endpointName, rawInput, callOpts = {}) {
        const { site, ep } = lookup(siteId, endpointName);
        const parsed = ep.input.safeParse(rawInput);
        if (!parsed.success)
            throw new WebtapError("bad_input", `bad input for ${siteId}/${endpointName}: ${parsed.error.message}`, [], parsed.error.issues);
        const input = parsed.data;
        const strategies = callOpts.strategy ? ep.strategies.filter((s) => s.name === callOpts.strategy) : ep.strategies;
        if (!strategies.length)
            throw new WebtapError("unknown_endpoint", `no strategy ${callOpts.strategy} on ${siteId}/${endpointName}`);
        const started = Date.now();
        const signal = AbortSignal.timeout(ep.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const attempts = [];
        const minIntervalMs = site.rateLimit?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
        const banCooldownMs = site.banCooldownMs ?? DEFAULT_BAN_COOLDOWN_MS;
        const record = (a) => {
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
                const tried = new Set();
                let errors = 0;
                /** Identities this call already retried on a fresh IP: one retry each, so one call never burns a pool of IPs. */
                const retriedAfterRotate = new Set();
                for (let i = 0; i < maxIdentityAttempts && !signal.aborted; i++) {
                    const proxyOnly = !!site.requireProxy;
                    const identity = await identities.acquire(site.id, { minIntervalMs, exclude: tried, maxWaitMs, signal, proxyOnly }).catch(() => null);
                    if (!identity) {
                        const why = proxyOnly && !identities.identities.some((x) => x.proxy)
                            ? "this site requires a proxy identity and none is configured"
                            : identities.allQuarantined(site.id, proxyOnly) ? "every identity is quarantined for this site" : tried.size ? "no other identity available" : "rate limited";
                        record({ strategy: strategy.name, outcome: "skipped", message: why, ms: 0 });
                        break;
                    }
                    tried.add(identity.id);
                    const t0 = Date.now();
                    let lease;
                    let outcome = "error";
                    let message = "";
                    try {
                        const ctx = {
                            site,
                            identity,
                            signal,
                            fetch: (req) => httpFetch(site, identity, req, signal),
                            session: async () => {
                                lease ??= await pool.lease(identity, site, signal);
                                return lease.session;
                            },
                        };
                        const raw = await raceSignal(strategy.run(ctx, input), signal);
                        const out = ep.output.safeParse(raw);
                        if (!out.success)
                            throw changed(`output does not match the schema: ${out.error.message.slice(0, 300)}`);
                        const bad = ep.verify?.(out.data, input);
                        if (bad)
                            throw changed(`verify: ${bad}`);
                        outcome = "ok";
                        const ms = Date.now() - t0;
                        identities.report(site.id, identity.id, "ok", banCooldownMs);
                        breaker.success(bkey);
                        stats.attempt(site.id, endpointName, strategy.name, "ok", ms);
                        record({ strategy: strategy.name, identity: identity.id, outcome: "ok", ms });
                        return { data: out.data, strategy: strategy.name, identity: identity.id, primary: index === 0 };
                    }
                    catch (err) {
                        const f = err instanceof StrategyFailure ? err : new StrategyFailure("error", signal.aborted ? "call timed out" : errMessage(err));
                        outcome = f.outcome;
                        message = f.message;
                    }
                    finally {
                        // A crashed or wedged browser is not trusted warm; neither is a banned one whose IP is about to change
                        // (its cookies belong to the old IP). Any other failure keeps the session and its solved challenge.
                        await lease?.release((outcome === "error" && (signal.aborted || BROWSER_BROKEN.test(message))) || (outcome === "banned" && !!identity.rotateUrl));
                    }
                    const ms = Date.now() - t0;
                    // A rotatable proxy gets a new IP instead of a long quarantine: a short pause, then it is usable again.
                    const rotated = outcome === "banned" && identity.rotateUrl ? await rotateIp(identity.rotateUrl) : false;
                    if (rotated)
                        message = `${message}; rotated the proxy IP`;
                    // Rotated: no quarantine, just a pause while the modem reconnects; the same call retries on the fresh IP.
                    identities.report(site.id, identity.id, outcome, rotated ? 0 : banCooldownMs);
                    if (rotated) {
                        identities.pause(site.id, identity.id, rotatePauseMs);
                        if (!retriedAfterRotate.has(identity.id)) {
                            retriedAfterRotate.add(identity.id);
                            tried.delete(identity.id);
                        }
                    }
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
                    // left; a ban only does after rotating the proxy's IP (above).
                    if (outcome === "error" && identities.identities.every((x) => tried.has(x.id) || (site.requireProxy && !x.proxy)))
                        tried.delete(identity.id);
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
    // ── Keeping sessions warm ──
    let keepAliveTimer;
    const warmSites = () => [...sites.values()].filter((s) => s.browser?.keepWarm);
    /** The site's primary identity: the first one it may use. */
    const primaryIdentity = (site) => identities.identities.find((i) => !site.requireProxy || i.proxy);
    /** Opens the session (initial) or revisits the site when the session has been idle for the keep-alive period. */
    async function keepAlive(site, initial) {
        const identity = primaryIdentity(site);
        if (!identity)
            return;
        const every = site.browser?.keepWarm?.everyMs ?? KEEP_WARM_EVERY_MS;
        const idle = pool.idleFor(identity, site);
        if (!initial && (idle === undefined || idle < every))
            return; // busy, closed, or recently used
        if (initial && idle !== undefined)
            return; // already open
        // Take a regular rate-limit slot so a keep-alive never lands right on top of a real call.
        const got = await identities.acquire(site.id, { minIntervalMs: site.rateLimit?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, maxWaitMs: initial ? 30_000 : 0, exclude: new Set(identities.identities.filter((i) => i.id !== identity.id).map((i) => i.id)) }).catch(() => null);
        if (!got)
            return;
        let lease;
        let broken = false;
        try {
            lease = await pool.lease(identity, site);
            const url = new URL(site.browser?.keepWarm?.url ?? "/", site.origin).toString();
            if (!initial)
                await lease.session.goto(url); // a fresh session already opened the site itself
        }
        catch {
            broken = true;
        }
        finally {
            await lease?.release(broken).catch(() => undefined);
        }
    }
    return {
        call,
        describe() {
            const out = [];
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
            const report = { sites: {}, identities: identities.status(), browserSessions: pool.size };
            for (const site of sites.values()) {
                const eps = {};
                for (const name of Object.keys(site.endpoints)) {
                    eps[name] = stats.snapshot(site.id, name, (strategy) => breaker.isOpen(`${site.id}/${name}/${strategy}`));
                }
                report.sites[site.id] = eps;
            }
            return report;
        },
        async runCanaries(o = {}) {
            const results = {};
            for (const site of sites.values()) {
                if (o.site && site.id !== o.site)
                    continue;
                for (const [name, ep] of Object.entries(site.endpoints)) {
                    if (!ep.canary)
                        continue;
                    const runs = o.perStrategy ? ep.strategies.map((s) => s.name) : [undefined];
                    for (const strategy of runs) {
                        const key = `${site.id}/${name}${strategy ? `#${strategy}` : ""}`;
                        const t0 = Date.now();
                        let r;
                        try {
                            const res = await call(site.id, name, ep.canary.input, strategy ? { strategy } : {});
                            const bad = (ep.canary.check ?? defaultCanaryCheck)(res.data);
                            r = { at: new Date().toISOString(), ok: !bad, strategy: res.strategy, ms: Date.now() - t0, ...(bad ? { message: bad } : {}) };
                        }
                        catch (err) {
                            r = { at: new Date().toISOString(), ok: false, message: errMessage(err), ms: Date.now() - t0, ...(strategy ? { strategy } : {}) };
                        }
                        if (!strategy)
                            stats.canary(site.id, name, r);
                        results[key] = r;
                    }
                }
            }
            return results;
        },
        async warm() {
            await Promise.allSettled(warmSites().map((site) => keepAlive(site, true)));
            keepAliveTimer ??= setInterval(() => {
                for (const site of warmSites())
                    void keepAlive(site, false);
            }, 30_000);
            keepAliveTimer.unref();
        },
        async close() {
            if (keepAliveTimer)
                clearInterval(keepAliveTimer);
            await pool.close();
            await Promise.allSettled([...dispatchers.values()].map((d) => d.close()));
        },
    };
}
/** "At least one item": passes when the first array found in the output (depth-first) is non-empty. */
export function defaultCanaryCheck(output) {
    const arr = firstArray(output, 0);
    if (arr === undefined)
        return null;
    return arr.length ? null : "empty result";
}
function firstArray(v, depth) {
    if (Array.isArray(v))
        return v;
    if (depth > 3 || typeof v !== "object" || v === null)
        return undefined;
    for (const x of Object.values(v)) {
        const a = firstArray(x, depth + 1);
        if (a)
            return a;
    }
    return undefined;
}
function summarize(attempts) {
    if (!attempts.length)
        return "no strategy ran";
    return attempts.map((a) => `${a.strategy}${a.identity ? `@${a.identity}` : ""}: ${a.outcome}${a.message ? ` (${a.message})` : ""}`).join("; ");
}
function toJsonSchema(schema, io) {
    try {
        return z.toJSONSchema(schema, { io, unrepresentable: "any" });
    }
    catch {
        return {};
    }
}
/** Rejects when the call's budget runs out, even if the strategy ignores the signal (a wedged page). */
function raceSignal(p, signal) {
    if (signal.aborted)
        return Promise.reject(new StrategyFailure("error", "call timed out"));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new StrategyFailure("error", "call timed out"));
        signal.addEventListener("abort", onAbort, { once: true });
        p.then((v) => {
            signal.removeEventListener("abort", onAbort);
            resolve(v);
        }, (e) => {
            signal.removeEventListener("abort", onAbort);
            reject(e);
        });
    });
}
/** Per-site concurrency cap (maxConcurrent). */
class Gate {
    max;
    active = 0;
    waiting = [];
    constructor(max) {
        this.max = max;
    }
    async run(fn) {
        if (this.active >= this.max)
            await new Promise((r) => this.waiting.push(r));
        this.active++;
        try {
            return await fn();
        }
        finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}
//# sourceMappingURL=webtap.js.map