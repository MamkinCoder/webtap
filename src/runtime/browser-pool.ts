// Warm browser sessions, one per (identity, site): its profile keeps the site's cookies and solved challenges, so a
// page-fetch call costs a fetch, not a launch. A session is used by one call at a time (lease / release). Bounded by
// maxSessions (least recently used idle session is closed first) and closed after idleMs without use.
import { join } from "node:path";
import type { ActionCache } from "../browser/cache.js";
import type { BrowserLauncher, BrowserSession } from "../types.js";
import type { Identity, SiteDef } from "./site.js";

export interface BrowserPoolOptions {
  launcher: BrowserLauncher;
  dataDir: string;
  cache: ActionCache;
  headless: boolean;
  /** Headful windows on screen instead of off-screen (debugging). */
  visible?: boolean;
  executablePath?: string;
  /** Concurrent Chromium processes. Default 4. */
  maxSessions?: number;
  /** Close a session unused for this long. Default 10 min. */
  idleMs?: number;
}

interface Entry {
  key: string;
  session: Promise<BrowserSession>;
  busy: boolean;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
}

export interface Lease {
  session: BrowserSession;
  /** broken = the session misbehaved (crash, wedged page): close it instead of keeping it warm. */
  release(broken?: boolean): Promise<void>;
}

const safe = (s: string): string => s.replace(/[^a-z0-9._-]/gi, "_");

export class BrowserPool {
  private readonly entries = new Map<string, Entry>();
  private readonly waiters: (() => void)[] = [];
  private closed = false;

  constructor(private readonly o: BrowserPoolOptions) {}

  private get max(): number {
    return Math.max(1, this.o.maxSessions ?? 4);
  }

  async lease(identity: Identity, site: SiteDef, signal?: AbortSignal): Promise<Lease> {
    const key = `${identity.id}\u0000${site.id}`;
    for (;;) {
      if (this.closed) throw new Error("webtap: browser pool is closed");
      signal?.throwIfAborted();
      const existing = this.entries.get(key);
      if (existing && !existing.busy) return this.take(existing);
      if (!existing) {
        if (this.entries.size < this.max) {
          const entry: Entry = { key, session: this.launch(identity, site), busy: false, lastUsed: Date.now() };
          this.entries.set(key, entry);
          entry.session.catch(() => this.entries.get(key) === entry && this.entries.delete(key));
          return this.take(entry);
        }
        // Full: close the least recently used idle session and look again (another call may take the room first).
        if (await this.evictIdle()) continue;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async take(entry: Entry): Promise<Lease> {
    entry.busy = true;
    clearTimeout(entry.idleTimer);
    let session: BrowserSession;
    try {
      session = await entry.session;
    } catch (err) {
      entry.busy = false;
      this.entries.delete(entry.key);
      this.wake();
      throw err;
    }
    let released = false;
    return {
      session,
      release: async (broken = false) => {
        if (released) return;
        released = true;
        entry.busy = false;
        entry.lastUsed = Date.now();
        if (broken || this.closed) {
          await this.drop(entry);
        } else {
          entry.idleTimer = setTimeout(() => void this.drop(entry), this.o.idleMs ?? 10 * 60_000);
          entry.idleTimer.unref();
        }
        this.wake();
      },
    };
  }

  private launch(identity: Identity, site: SiteDef): Promise<BrowserSession> {
    const profile = join(this.o.dataDir, "profiles", `${safe(identity.id)}__${safe(site.id)}`);
    return this.o.launcher.launch({
      headless: site.browser?.headless ?? this.o.headless,
      ...(this.o.visible ? { visible: true } : {}),
      userDataDir: profile,
      snapshotDir: join(this.o.dataDir, "snapshots", safe(site.id)),
      cache: this.o.cache,
      ...(this.o.executablePath ? { executablePath: this.o.executablePath } : {}),
      ...(identity.proxy ? { proxy: identity.proxy } : {}),
      ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
      ...(identity.languages ? { languages: identity.languages } : {}),
      ...(site.browser?.blockAssets !== undefined ? { blockAssets: site.browser.blockAssets } : { blockAssets: true }),
      ...(site.browser?.loadImages !== undefined ? { loadImages: site.browser.loadImages } : {}),
      ...(site.browser?.blockUrls ? { blockUrls: site.browser.blockUrls } : {}),
    });
  }

  /** Closes the least recently used idle session; false when every session is busy. */
  private async evictIdle(): Promise<boolean> {
    let lru: Entry | undefined;
    for (const e of this.entries.values()) if (!e.busy && (!lru || e.lastUsed < lru.lastUsed)) lru = e;
    if (!lru) return false;
    await this.drop(lru);
    return true;
  }

  private async drop(entry: Entry): Promise<void> {
    clearTimeout(entry.idleTimer);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    try {
      await (await entry.session).close();
    } catch {
      // already gone
    }
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  get size(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.entries.values()].map((e) => this.drop(e)));
    this.wake();
  }
}
