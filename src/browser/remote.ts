// A browser that runs elsewhere (another container, another machine) and is driven over its DevTools port: the clean
// engine attaches to it instead of spawning Chrome. The browser owns its profile, proxy and persona; webtap owns one
// tab per session. Closing a session never closes the browser (that would end its profile's life and, for a licensed
// binary, its seat): it leaves the tab, and the next session of the same browser replaces it with a fresh one.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { RawCdp } from "./cdp.js";

/** Tabs of live sessions, per remote browser (its configured url). Any other page of that browser is a leftover (a
 * dropped session, a previous run of this process) and is closed when a new session opens. */
const liveTabs = new Map<string, Set<string>>();

/**
 * The browser websocket of a DevTools endpoint: "ws://…" as is, "http://host:port" through /json/version. Chrome's
 * DevTools server only answers a Host header that is an IP or "localhost" (DNS-rebinding guard), so a host name (a
 * Docker service) is resolved to its address first, and the websocket url is pointed at that address too: Chrome
 * writes back the Host it was asked with, which a port relay in front of it may not match.
 */
export async function browserWsUrl(cdpUrl: string, timeoutMs = 5_000): Promise<string> {
  const u = new URL(cdpUrl);
  if (u.protocol === "ws:" || u.protocol === "wss:") return cdpUrl;
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`remote browser: unsupported url ${cdpUrl}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const address = isIP(host) || host === "localhost" ? host : (await lookup(host)).address;
  const hostPort = `${isIP(address) === 6 ? `[${address}]` : address}${u.port ? `:${u.port}` : ""}`;
  const res = await fetch(`${u.protocol}//${hostPort}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`remote browser: ${cdpUrl}/json/version answered ${res.status}`);
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!webSocketDebuggerUrl) throw new Error(`remote browser: no webSocketDebuggerUrl at ${cdpUrl}`);
  return rewriteWsHost(webSocketDebuggerUrl, hostPort, u.protocol === "https:");
}

/** The same websocket path on `hostPort` (the address the DevTools endpoint was actually reached at). */
export function rewriteWsHost(wsUrl: string, hostPort: string, secure = false): string {
  const ws = new URL(wsUrl);
  return `${secure ? "wss" : "ws"}://${hostPort}${ws.pathname}${ws.search}`;
}

type TargetInfo = { type: string; targetId: string; url: string };

/** Opens a fresh tab for a session and closes the browser's leftover pages (never another live session's tab). */
export async function openRemoteTab(cdp: RawCdp, browserKey: string): Promise<{ targetId: string; release: () => void }> {
  const live = liveTabs.get(browserKey) ?? new Set<string>();
  liveTabs.set(browserKey, live);
  // A new tab rather than the old one: a "broken" session may have left a wedged renderer, and a tab of its own gives
  // the site a clean document. Created first, so the browser never runs out of windows (headful Chrome exits then).
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  live.add(targetId);
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type !== "page" || live.has(t.targetId)) continue;
    await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
  }
  return { targetId, release: () => void live.delete(targetId) };
}

/** Origins to clear for a set of cookies: each cookie domain over https and http. */
export function cookieOrigins(cookies: { domain: string }[]): string[] {
  const hosts = new Set(cookies.map((c) => c.domain.replace(/^\./, "")).filter(Boolean));
  return [...hosts].flatMap((h) => [`https://${h}`, `http://${h}`]);
}

/**
 * Forgets everything sites stored in a remote browser: cookies, storage (local, session, IndexedDB, cache storage,
 * service workers) and the HTTP cache. The remote counterpart of deleting a profile folder, e.g. after an IP change,
 * when the old cookies are what still ties the new address to the banned one. Every page is closed first (a page left
 * open would write its site's state right back); one blank tab remains. `origins`: also clear these (sites that may
 * have stored data without a cookie).
 */
export async function wipeRemoteBrowser(cdpUrl: string, origins: string[] = []): Promise<{ origins: number; cookies: number }> {
  const cdp = await RawCdp.connect(await browserWsUrl(cdpUrl));
  try {
    // Live sessions of this browser lose their tabs too (their next command fails, and the pool reopens them).
    liveTabs.get(cdpUrl)?.clear();
    const tab = await openRemoteTab(cdp, cdpUrl);
    const { targetId } = tab;
    tab.release(); // a leftover for the next session to replace
    const { cookies } = await cdp.send<{ cookies: { domain: string }[] }>("Storage.getCookies");
    const all = new Set([...cookieOrigins(cookies), ...origins.map((o) => new URL(o).origin)]);
    // Storage.clearDataForOrigin answers "Internal error" at the browser level: it needs a page session.
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    for (const origin of all) await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }, sessionId);
    await cdp.send("Storage.clearCookies");
    await cdp.send("Network.clearBrowserCache", {}, sessionId);
    return { origins: all.size, cookies: cookies.length };
  } finally {
    cdp.close();
  }
}
