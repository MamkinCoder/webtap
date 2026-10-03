import type { ActionCache } from "../browser/cache.js";
import type { BrowserLauncher, BrowserSession } from "../types.js";
import type { Identity, SiteDef } from "./site.js";
export interface BrowserPoolOptions {
    launcher: BrowserLauncher;
    /** For sites with browser.engine "clean". */
    cleanLauncher?: BrowserLauncher;
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
export interface Lease {
    session: BrowserSession;
    /** broken = the session misbehaved (crash, wedged page): close it instead of keeping it warm. */
    release(broken?: boolean): Promise<void>;
}
export declare class BrowserPool {
    private readonly o;
    private readonly entries;
    private readonly waiters;
    private closed;
    constructor(o: BrowserPoolOptions);
    private get max();
    lease(identity: Identity, site: SiteDef, signal?: AbortSignal): Promise<Lease>;
    private take;
    private launch;
    /** Closes the least recently used idle session; false when every session is busy. */
    private evictIdle;
    private drop;
    private wake;
    /** Milliseconds since this session was last released; undefined when there is none or it is in use. */
    idleFor(identity: Identity, site: SiteDef): number | undefined;
    get size(): number;
    close(): Promise<void>;
}
