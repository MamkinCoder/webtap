import { RawCdp } from "./cdp.js";
/**
 * The browser websocket of a DevTools endpoint: "ws://…" as is, "http://host:port" through /json/version. Chrome's
 * DevTools server only answers a Host header that is an IP or "localhost" (DNS-rebinding guard), so a host name (a
 * Docker service) is resolved to its address first, and the websocket url is pointed at that address too: Chrome
 * writes back the Host it was asked with, which a port relay in front of it may not match.
 */
export declare function browserWsUrl(cdpUrl: string, timeoutMs?: number): Promise<string>;
/** The same websocket path on `hostPort` (the address the DevTools endpoint was actually reached at). */
export declare function rewriteWsHost(wsUrl: string, hostPort: string, secure?: boolean): string;
/** Opens a fresh tab for a session and closes the browser's leftover pages (never another live session's tab). */
export declare function openRemoteTab(cdp: RawCdp, browserKey: string): Promise<{
    targetId: string;
    release: () => void;
}>;
/** Origins to clear for a set of cookies: each cookie domain over https and http. */
export declare function cookieOrigins(cookies: {
    domain: string;
}[]): string[];
/**
 * Forgets everything sites stored in a remote browser: cookies, storage (local, session, IndexedDB, cache storage,
 * service workers) and the HTTP cache. The remote counterpart of deleting a profile folder, e.g. after an IP change,
 * when the old cookies are what still ties the new address to the banned one. Every page is closed first (a page left
 * open would write its site's state right back); one blank tab remains. `origins`: also clear these (sites that may
 * have stored data without a cookie).
 */
export declare function wipeRemoteBrowser(cdpUrl: string, origins?: string[]): Promise<{
    origins: number;
    cookies: number;
}>;
