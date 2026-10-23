import type { Cookie } from "../types.js";
export interface SessionBundle {
    v: 1;
    site: string;
    /** The identity (exit IP + persona) it was recorded on: a site may tie the session to it. Informational. */
    identity?: string;
    /** ISO time of the export. */
    createdAt: string;
    cookies: Cookie[];
}
export declare const KEY_PREFIX = "wts1.";
export declare function encodeSessionKey(bundle: SessionBundle, secret: string): string;
export declare function decodeSessionKey(key: string, secret: string): SessionBundle;
/** What a bundle holds, without its values: for logs and `webtap session info`. */
export declare function describeSession(b: SessionBundle, now?: number): {
    site: string;
    cookies: number;
    domains: string[];
    expiresAt?: string;
    expired: boolean;
};
/**
 * The cookies that belong to a site: those on its origin's host or its parent domain (".avito.ru" for www.avito.ru).
 * shortcut: the parent is the last two labels, which is wrong under a public suffix like co.uk, upgrade to a suffix list
 * when a site needs it (SiteDef.session.domains overrides this).
 */
export declare function siteCookies(cookies: Cookie[], origin: string, domains?: string[]): Cookie[];
