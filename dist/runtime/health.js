export class Breaker {
    now;
    state = new Map();
    threshold;
    cooldownMs;
    constructor(o = {}, now = Date.now) {
        this.now = now;
        this.threshold = o.threshold ?? 3;
        this.cooldownMs = o.cooldownMs ?? 60_000;
    }
    /** Open breakers allow nothing until the cooldown ends; then one trial call (a failure reopens it at once). */
    allow(key) {
        const s = this.state.get(key);
        return !s || s.openUntil <= this.now();
    }
    isOpen(key) {
        return !this.allow(key);
    }
    success(key) {
        this.state.delete(key);
    }
    failure(key) {
        const s = this.state.get(key) ?? { failures: 0, openUntil: 0 };
        s.failures++;
        if (s.failures >= this.threshold)
            s.openUntil = this.now() + this.cooldownMs;
        this.state.set(key, s);
    }
}
export class Stats {
    now;
    endpoints = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    ep(site, endpoint) {
        const key = `${site}/${endpoint}`;
        let e = this.endpoints.get(key);
        if (!e) {
            e = { status: "unknown", calls: 0, failures: 0, strategies: new Map() };
            this.endpoints.set(key, e);
        }
        return e;
    }
    attempt(site, endpoint, strategy, outcome, ms, message) {
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
        }
        else {
            s.lastFailure = { at, outcome, message: message ?? "" };
        }
    }
    call(site, endpoint, ok, primary, strategy, message) {
        const e = this.ep(site, endpoint);
        e.calls++;
        if (!ok)
            e.failures++;
        e.status = !ok ? "down" : primary ? "ok" : "degraded";
        e.lastCall = { at: new Date(this.now()).toISOString(), ok, ...(strategy ? { strategy } : {}), ...(message ? { message } : {}) };
    }
    canary(site, endpoint, r) {
        this.ep(site, endpoint).canary = r;
    }
    snapshot(site, endpoint, breakerOpen) {
        const e = this.ep(site, endpoint);
        const strategies = {};
        for (const [name, s] of e.strategies)
            strategies[name] = { ...s, breakerOpen: breakerOpen(name) };
        const { strategies: _s, ...rest } = e;
        return { ...rest, strategies };
    }
}
//# sourceMappingURL=health.js.map