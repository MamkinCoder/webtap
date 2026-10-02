// Action cache: observe() results (selector + method + args) keyed by host and step key,
// persisted as one JSON file per host. A replay that fails twice in a row drops the entry.
// One instance is shared by every browser session of a runtime, so a step healed in one session is
// replayed by all of them, and concurrent heals of the same step share one LLM call (heal()).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const MAX_FAILURES = 2;
export const hostOf = (url) => {
    try {
        const u = new URL(url);
        return u.host || u.protocol.replace(":", "") || "local";
    }
    catch {
        return "local";
    }
};
const cacheFile = (dir, host) => join(dir, `${host.replace(/[^a-z0-9.-]/gi, "_") || "local"}.json`);
function readHostCache(dir, host) {
    try {
        const raw = JSON.parse(readFileSync(cacheFile(dir, host), "utf8"));
        return isRecord(raw) ? raw : {};
    }
    catch {
        return {};
    }
}
/** tmp + rename so a crash mid-write never leaves a truncated file. */
function writeHostCache(dir, host, cache) {
    mkdirSync(dir, { recursive: true });
    const file = cacheFile(dir, host);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, file);
}
function recordSuccess(cache, key, action, now = new Date()) {
    const prev = cache[key];
    const same = prev && prev.selector === action.selector && prev.method === action.method;
    return {
        ...cache,
        [key]: {
            selector: action.selector,
            method: action.method,
            arguments: [...action.arguments],
            description: action.description,
            hits: same ? prev.hits + 1 : 1,
            lastOkAt: now.toISOString(),
            failures: 0,
        },
    };
}
/** Counts a replay failure; the entry is removed once MAX_FAILURES is reached. */
function recordFailure(cache, key) {
    const prev = cache[key];
    if (!prev)
        return cache;
    const failures = prev.failures + 1;
    if (failures >= MAX_FAILURES)
        return invalidate(cache, key);
    return { ...cache, [key]: { ...prev, failures } };
}
function invalidate(cache, key) {
    if (!(key in cache))
        return cache;
    const { [key]: _dropped, ...rest } = cache;
    return rest;
}
/** In-memory per-host cache with write-through to `dir` (memory-only when dir is undefined). */
export class ActionCache {
    dir;
    hosts = new Map();
    healing = new Map();
    constructor(dir) {
        this.dir = dir;
    }
    load(host) {
        let c = this.hosts.get(host);
        if (!c) {
            c = this.dir ? readHostCache(this.dir, host) : {};
            this.hosts.set(host, c);
        }
        return c;
    }
    store(host, cache) {
        this.hosts.set(host, cache);
        if (this.dir) {
            try {
                writeHostCache(this.dir, host, cache);
            }
            catch {
                // a cache write failure must never break an action
            }
        }
    }
    get(host, key) {
        return this.load(host)[key];
    }
    success(host, key, action) {
        this.store(host, recordSuccess(this.load(host), key, action));
    }
    failure(host, key) {
        this.store(host, recordFailure(this.load(host), key));
    }
    invalidate(host, key) {
        this.store(host, invalidate(this.load(host), key));
    }
    /**
     * Runs `fn` (observe + perform + save) unless a heal of the same step is already running; then it waits for that
     * one and returns { ran: false }, and the caller replays whatever it saved.
     */
    async heal(host, key, fn) {
        const id = `${host}\u0000${key}`;
        const running = this.healing.get(id);
        if (running) {
            await running.catch(() => undefined);
            return { ran: false };
        }
        const p = fn();
        this.healing.set(id, p);
        try {
            return { ran: true, value: await p };
        }
        finally {
            this.healing.delete(id);
        }
    }
}
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
//# sourceMappingURL=cache.js.map