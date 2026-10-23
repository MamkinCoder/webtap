// A session key: the cookies of a logged-in browser, sealed into one string that can travel as an env var, a secret-manager
// value or a pasted line. Log in once on a machine with a screen (`webtap login`), ship the key, import it on the server.
//
// Format: "wts1." + base64url(salt[16] | iv[12] | gcm tag[16] | ciphertext). The ciphertext is AES-256-GCM over the bundle
// JSON, keyed by scrypt(secret, salt). Cookies are credentials, so there is no unsealed form: a key without its secret is
// noise, and a flipped bit fails authentication instead of importing garbage.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
export const KEY_PREFIX = "wts1.";
const SALT = 16;
const IV = 12;
const TAG = 16;
const derive = (secret, salt) => scryptSync(secret, salt, 32);
export function encodeSessionKey(bundle, secret) {
    if (!secret)
        throw new Error("webtap: a session key needs a secret (WEBTAP_SESSION_SECRET)");
    const salt = randomBytes(SALT);
    const iv = randomBytes(IV);
    const cipher = createCipheriv("aes-256-gcm", derive(secret, salt), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(bundle), "utf8"), cipher.final()]);
    return KEY_PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function decodeSessionKey(key, secret) {
    if (!secret)
        throw new Error("webtap: a session key needs a secret (WEBTAP_SESSION_SECRET)");
    const trimmed = key.trim();
    if (!trimmed.startsWith(KEY_PREFIX))
        throw new Error("webtap: not a session key (expected the wts1. prefix)");
    const raw = Buffer.from(trimmed.slice(KEY_PREFIX.length), "base64url");
    if (raw.length <= SALT + IV + TAG)
        throw new Error("webtap: session key is truncated");
    const decipher = createDecipheriv("aes-256-gcm", derive(secret, raw.subarray(0, SALT)), raw.subarray(SALT, SALT + IV));
    decipher.setAuthTag(raw.subarray(SALT + IV, SALT + IV + TAG));
    let json;
    try {
        json = Buffer.concat([decipher.update(raw.subarray(SALT + IV + TAG)), decipher.final()]).toString("utf8");
    }
    catch {
        throw new Error("webtap: session key does not open: wrong secret, or the key was altered");
    }
    const bundle = JSON.parse(json);
    if (bundle.v !== 1 || typeof bundle.site !== "string" || !Array.isArray(bundle.cookies))
        throw new Error("webtap: unsupported session bundle");
    return bundle;
}
/** What a bundle holds, without its values: for logs and `webtap session info`. */
export function describeSession(b, now = Date.now()) {
    // Session cookies (expires <= 0) die with the browser; the soonest real expiry is when the login is likely to lapse.
    const dated = b.cookies.map((c) => c.expires).filter((e) => e > 0);
    const soonest = dated.length ? Math.min(...dated) * 1000 : undefined;
    return {
        site: b.site,
        cookies: b.cookies.length,
        domains: [...new Set(b.cookies.map((c) => c.domain))].sort(),
        ...(soonest ? { expiresAt: new Date(soonest).toISOString() } : {}),
        expired: soonest !== undefined && soonest < now,
    };
}
/**
 * The cookies that belong to a site: those on its origin's host or its parent domain (".avito.ru" for www.avito.ru).
 * shortcut: the parent is the last two labels, which is wrong under a public suffix like co.uk, upgrade to a suffix list
 * when a site needs it (SiteDef.session.domains overrides this).
 */
export function siteCookies(cookies, origin, domains) {
    const host = new URL(origin).hostname;
    const roots = domains?.length ? domains : [host.split(".").slice(-2).join(".")];
    return cookies.filter((c) => {
        const d = c.domain.replace(/^\./, "").toLowerCase();
        return roots.some((r) => d === r || d.endsWith(`.${r}`));
    });
}
//# sourceMappingURL=key.js.map