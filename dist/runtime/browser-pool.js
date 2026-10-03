// Warm browser sessions, one per (identity, site): its profile keeps the site's cookies and solved challenges, so a
// page-fetch call costs a fetch, not a launch. A session is used by one call at a time (lease / release). Bounded by
// maxSessions (least recently used idle session is closed first) and closed after idleMs without use.
import { join } from "node:path";
const safe = (s) => s.replace(/[^a-z0-9._-]/gi, "_");
export class BrowserPool {
    o;
    entries = new Map();
    waiters = [];
    closed = false;
    constructor(o) {
        this.o = o;
    }
    get max() {
        return Math.max(1, this.o.maxSessions ?? 4);
    }
    async lease(identity, site, signal) {
        const key = `${identity.id}\u0000${site.id}`;
        for (;;) {
            if (this.closed)
                throw new Error("webtap: browser pool is closed");
            signal?.throwIfAborted();
            const existing = this.entries.get(key);
            if (existing && !existing.busy)
                return this.take(existing);
            if (!existing) {
                if (this.entries.size < this.max) {
                    const entry = { key, session: this.launch(identity, site), busy: false, lastUsed: Date.now(), keepWarm: !!site.browser?.keepWarm };
                    this.entries.set(key, entry);
                    entry.session.catch(() => this.entries.get(key) === entry && this.entries.delete(key));
                    return this.take(entry);
                }
                // Full: close the least recently used idle session and look again (another call may take the room first).
                if (await this.evictIdle())
                    continue;
            }
            await new Promise((resolve) => this.waiters.push(resolve));
        }
    }
    async take(entry) {
        entry.busy = true;
        clearTimeout(entry.idleTimer);
        let session;
        try {
            session = await entry.session;
        }
        catch (err) {
            entry.busy = false;
            this.entries.delete(entry.key);
            this.wake();
            throw err;
        }
        let released = false;
        return {
            session,
            release: async (broken = false) => {
                if (released)
                    return;
                released = true;
                entry.busy = false;
                entry.lastUsed = Date.now();
                if (broken || this.closed) {
                    await this.drop(entry);
                }
                else if (!entry.keepWarm) {
                    entry.idleTimer = setTimeout(() => void this.drop(entry), this.o.idleMs ?? 10 * 60_000);
                    entry.idleTimer.unref();
                }
                this.wake();
            },
        };
    }
    launch(identity, site) {
        const profile = join(this.o.dataDir, "profiles", `${safe(identity.id)}__${safe(site.id)}`);
        const clean = site.browser?.engine === "clean";
        const launcher = clean ? this.o.cleanLauncher : this.o.launcher;
        if (!launcher)
            throw new Error(`webtap: site ${site.id} needs the clean engine, but no clean launcher is configured`);
        return launcher.launch({
            // The clean engine has Chrome open the site itself, before any CDP command touches the page.
            ...(clean ? { startUrl: new URL("/", site.origin).toString() } : {}),
            headless: site.browser?.headless ?? this.o.headless,
            ...(this.o.visible ? { visible: true } : {}),
            userDataDir: profile,
            snapshotDir: join(this.o.dataDir, "snapshots", safe(site.id)),
            cache: this.o.cache,
            ...(this.o.executablePath ? { executablePath: this.o.executablePath } : {}),
            ...(identity.proxy ? { proxy: identity.proxy } : {}),
            ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
            ...(identity.os ? { os: identity.os } : {}),
            // A remote browser serves the identity's clean-engine sites, a tab each; Stagehand needs a Chrome of its own.
            ...(clean && identity.remote ? { remote: identity.remote } : {}),
            ...(identity.languages ? { languages: identity.languages } : {}),
            ...(site.browser?.blockAssets !== undefined ? { blockAssets: site.browser.blockAssets } : { blockAssets: true }),
            ...(site.browser?.loadImages !== undefined ? { loadImages: site.browser.loadImages } : {}),
            ...(site.browser?.blockUrls ? { blockUrls: site.browser.blockUrls } : {}),
        });
    }
    /** Closes the least recently used idle session; false when every session is busy. */
    async evictIdle() {
        let lru;
        // Ordinary sessions go first; a kept-warm one only when nothing else is idle.
        for (const e of this.entries.values())
            if (!e.busy && (!lru || Number(e.keepWarm) < Number(lru.keepWarm) || (e.keepWarm === lru.keepWarm && e.lastUsed < lru.lastUsed)))
                lru = e;
        if (!lru)
            return false;
        await this.drop(lru);
        return true;
    }
    async drop(entry) {
        clearTimeout(entry.idleTimer);
        if (this.entries.get(entry.key) === entry)
            this.entries.delete(entry.key);
        try {
            await (await entry.session).close();
        }
        catch {
            // already gone
        }
        this.wake();
    }
    wake() {
        for (const w of this.waiters.splice(0))
            w();
    }
    /** Milliseconds since this session was last released; undefined when there is none or it is in use. */
    idleFor(identity, site) {
        const e = this.entries.get(`${identity.id}\u0000${site.id}`);
        return e && !e.busy ? Date.now() - e.lastUsed : undefined;
    }
    get size() {
        return this.entries.size;
    }
    async close() {
        this.closed = true;
        await Promise.allSettled([...this.entries.values()].map((e) => this.drop(e)));
        this.wake();
    }
}
//# sourceMappingURL=browser-pool.js.map