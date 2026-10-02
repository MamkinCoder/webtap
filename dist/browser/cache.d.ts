export interface CachedAction {
    selector: string;
    method: string;
    arguments: string[];
    description: string;
}
export interface CacheEntry extends CachedAction {
    hits: number;
    lastOkAt: string;
    failures: number;
}
export declare const hostOf: (url: string) => string;
/** In-memory per-host cache with write-through to `dir` (memory-only when dir is undefined). */
export declare class ActionCache {
    private readonly dir?;
    private readonly hosts;
    private readonly healing;
    constructor(dir?: string | undefined);
    private load;
    private store;
    get(host: string, key: string): CacheEntry | undefined;
    success(host: string, key: string, action: CachedAction): void;
    failure(host: string, key: string): void;
    invalidate(host: string, key: string): void;
    /**
     * Runs `fn` (observe + perform + save) unless a heal of the same step is already running; then it waits for that
     * one and returns { ran: false }, and the caller replays whatever it saved.
     */
    heal<T>(host: string, key: string, fn: () => Promise<T>): Promise<{
        ran: true;
        value: T;
    } | {
        ran: false;
    }>;
}
