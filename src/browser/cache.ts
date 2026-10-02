// Action cache: observe() results (selector + method + args) keyed by host and step key,
// persisted as one JSON file per host. A replay that fails twice in a row drops the entry.
// One instance is shared by every browser session of a runtime, so a step healed in one session is
// replayed by all of them, and concurrent heals of the same step share one LLM call (heal()).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CachedAction {
  selector: string;
  method: string;
  arguments: string[];
  description: string;
}

export interface CacheEntry extends CachedAction {
  hits: number;
  lastOkAt: string; // ISO
  failures: number; // consecutive replay failures
}

type HostCache = Record<string, CacheEntry>;

const MAX_FAILURES = 2;

export const hostOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.host || u.protocol.replace(":", "") || "local";
  } catch {
    return "local";
  }
};

const cacheFile = (dir: string, host: string): string =>
  join(dir, `${host.replace(/[^a-z0-9.-]/gi, "_") || "local"}.json`);

function readHostCache(dir: string, host: string): HostCache {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(dir, host), "utf8")) as unknown;
    return isRecord(raw) ? (raw as HostCache) : {};
  } catch {
    return {};
  }
}

/** tmp + rename so a crash mid-write never leaves a truncated file. */
function writeHostCache(dir: string, host: string, cache: HostCache): void {
  mkdirSync(dir, { recursive: true });
  const file = cacheFile(dir, host);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, file);
}

function recordSuccess(cache: HostCache, key: string, action: CachedAction, now = new Date()): HostCache {
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
function recordFailure(cache: HostCache, key: string): HostCache {
  const prev = cache[key];
  if (!prev) return cache;
  const failures = prev.failures + 1;
  if (failures >= MAX_FAILURES) return invalidate(cache, key);
  return { ...cache, [key]: { ...prev, failures } };
}

function invalidate(cache: HostCache, key: string): HostCache {
  if (!(key in cache)) return cache;
  const { [key]: _dropped, ...rest } = cache;
  return rest;
}

/** In-memory per-host cache with write-through to `dir` (memory-only when dir is undefined). */
export class ActionCache {
  private readonly hosts = new Map<string, HostCache>();
  private readonly healing = new Map<string, Promise<unknown>>();

  constructor(private readonly dir?: string) {}

  private load(host: string): HostCache {
    let c = this.hosts.get(host);
    if (!c) {
      c = this.dir ? readHostCache(this.dir, host) : {};
      this.hosts.set(host, c);
    }
    return c;
  }

  private store(host: string, cache: HostCache): void {
    this.hosts.set(host, cache);
    if (this.dir) {
      try {
        writeHostCache(this.dir, host, cache);
      } catch {
        // a cache write failure must never break an action
      }
    }
  }

  get(host: string, key: string): CacheEntry | undefined {
    return this.load(host)[key];
  }

  success(host: string, key: string, action: CachedAction): void {
    this.store(host, recordSuccess(this.load(host), key, action));
  }

  failure(host: string, key: string): void {
    this.store(host, recordFailure(this.load(host), key));
  }

  invalidate(host: string, key: string): void {
    this.store(host, invalidate(this.load(host), key));
  }

  /**
   * Runs `fn` (observe + perform + save) unless a heal of the same step is already running; then it waits for that
   * one and returns { ran: false }, and the caller replays whatever it saved.
   */
  async heal<T>(host: string, key: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
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
    } finally {
      this.healing.delete(id);
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
