import type { Identity } from "./site.js";
export interface IdentitySiteStatus {
    identity: string;
    site: string;
    state: "ready" | "quarantined";
    quarantinedForMs: number;
    ok: number;
    banned: number;
    failed: number;
}
export interface AcquireOptions {
    minIntervalMs: number;
    /** Identities already tried in this call. */
    exclude?: ReadonlySet<string>;
    /** Give up instead of waiting longer than this for a slot. */
    maxWaitMs: number;
    signal?: AbortSignal;
    /** Only identities that go through a proxy. */
    proxyOnly?: boolean;
}
export declare class IdentityPool {
    readonly identities: readonly Identity[];
    private readonly now;
    private readonly random;
    private readonly slots;
    constructor(identities: readonly Identity[], now?: () => number, random?: () => number);
    private slot;
    /**
     * Reserves an identity for this site and waits for its slot: the first one (in list order) that is free now, so
     * earlier identities are primaries and later ones take the overflow; when none is free, the one free soonest. null when every candidate is
     * quarantined or the wait would exceed maxWaitMs (the caller reports "rate limited" / "all identities banned").
     */
    acquire(siteId: string, o: AcquireOptions): Promise<Identity | null>;
    report(siteId: string, identityId: string, outcome: "ok" | "banned" | "changed" | "error", banCooldownMs: number): void;
    /** Holds the identity's next slot for this site at least `ms` away (e.g. while a rotated proxy reconnects). */
    pause(siteId: string, identityId: string, ms: number): void;
    /** Why acquire() returned null: true when every identity is quarantined for this site. */
    allQuarantined(siteId: string, proxyOnly?: boolean): boolean;
    status(): IdentitySiteStatus[];
}
