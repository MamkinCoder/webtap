// Identities are the real capacity: a site bans an IP + fingerprint + cookies, not a server. Per (identity, site) this
// keeps a request slot (rate limit) and a quarantine after bans, so a ban on one site never benches the identity
// elsewhere. In-memory; a Redis-backed pool can implement the same surface for several workers.
import { setTimeout as sleep } from "node:timers/promises";
const MAX_QUARANTINE_MS = 6 * 60 * 60_000;
export class IdentityPool {
    identities;
    now;
    random;
    slots = new Map();
    constructor(identities, now = Date.now, random = Math.random) {
        this.identities = identities;
        this.now = now;
        this.random = random;
        if (!identities.length)
            throw new Error("webtap: at least one identity is required");
        const ids = new Set(identities.map((i) => i.id));
        if (ids.size !== identities.length)
            throw new Error("webtap: identity ids must be unique");
    }
    slot(identityId, siteId) {
        const key = `${identityId}\u0000${siteId}`;
        let s = this.slots.get(key);
        if (!s) {
            s = { nextAt: 0, quarantinedUntil: 0, consecutiveBans: 0, ok: 0, banned: 0, failed: 0 };
            this.slots.set(key, s);
        }
        return s;
    }
    /**
     * Reserves an identity for this site and waits for its slot: the first one (in list order) that is free now, so
     * earlier identities are primaries and later ones take the overflow; when none is free, the one free soonest. null when every candidate is
     * quarantined or the wait would exceed maxWaitMs (the caller reports "rate limited" / "all identities banned").
     */
    async acquire(siteId, o) {
        const t = this.now();
        // The first identity in list order that is free right now (a primary with spill-over), else the one free soonest.
        let best;
        for (const identity of this.identities) {
            if (o.exclude?.has(identity.id))
                continue;
            if (o.proxyOnly && !identity.proxy)
                continue;
            const slot = this.slot(identity.id, siteId);
            if (slot.quarantinedUntil > t)
                continue;
            if (slot.nextAt <= t) {
                best = { identity, slot };
                break;
            }
            if (!best || slot.nextAt < best.slot.nextAt)
                best = { identity, slot };
        }
        if (!best)
            return null;
        const wait = Math.max(0, best.slot.nextAt - t);
        if (wait > o.maxWaitMs)
            return null;
        // ±30% jitter: the same average pace, without the metronome a bot keeps.
        best.slot.nextAt = Math.max(t, best.slot.nextAt) + Math.round(o.minIntervalMs * (0.7 + this.random() * 0.6));
        if (wait > 0)
            await sleep(wait, undefined, o.signal ? { signal: o.signal } : undefined);
        return best.identity;
    }
    report(siteId, identityId, outcome, banCooldownMs) {
        const s = this.slot(identityId, siteId);
        if (outcome === "ok") {
            s.ok++;
            s.consecutiveBans = 0;
            return;
        }
        if (outcome !== "banned") {
            s.failed++;
            return;
        }
        s.banned++;
        s.consecutiveBans++;
        s.lastBanAt = this.now();
        s.quarantinedUntil = this.now() + Math.min(MAX_QUARANTINE_MS, banCooldownMs * 2 ** (s.consecutiveBans - 1));
    }
    /** Holds the identity's next slot for this site at least `ms` away (e.g. while a rotated proxy reconnects). */
    pause(siteId, identityId, ms) {
        const s = this.slot(identityId, siteId);
        s.nextAt = Math.max(s.nextAt, this.now() + ms);
    }
    /** Why acquire() returned null: true when every identity is quarantined for this site. */
    allQuarantined(siteId, proxyOnly = false) {
        const t = this.now();
        return this.identities.filter((i) => !proxyOnly || i.proxy).every((i) => this.slot(i.id, siteId).quarantinedUntil > t);
    }
    status() {
        const t = this.now();
        return [...this.slots.entries()].map(([key, s]) => {
            const [identity = "", site = ""] = key.split("\u0000");
            const q = Math.max(0, s.quarantinedUntil - t);
            return { identity, site, state: q > 0 ? "quarantined" : "ready", quarantinedForMs: q, ok: s.ok, banned: s.banned, failed: s.failed };
        });
    }
}
//# sourceMappingURL=identity.js.map