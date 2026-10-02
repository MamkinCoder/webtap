// What a plain-HTTP request looks like: a coherent Chrome, the same one the browser strategies run. A bare or
// mismatched set (a Chrome user agent without client hints, hints for another version, no fetch metadata) is a
// classic bot tell; real headers cost nothing.
import { desktopUserAgent, findChrome } from "../browser/launcher.js";
import type { Identity, SiteDef } from "./site.js";

const DEFAULT_MAJOR = "140";
let localUA: string | undefined;

/** The installed Chrome's own reduced UA (cached), or a desktop Chrome UA of a recent version. */
export function defaultUserAgent(): string {
  localUA ??=
    desktopUserAgent(findChrome()) ||
    `Mozilla/5.0 (${process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${DEFAULT_MAJOR}.0.0.0 Safari/537.36`;
  return localUA;
}

const platformOf = (ua: string): string => (/Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : "Linux");

/** Accept-Language the way Chrome writes it: "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7". */
export function acceptLanguage(langs: string[]): string {
  return langs.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(",");
}

/**
 * Chrome's headers for an XHR/fetch to `url` from a page of `site`: user agent + matching client hints, fetch
 * metadata, referer (and origin when Chrome would send it). Recipe headers are applied on top.
 */
export function browserHeaders(identity: Identity, site: SiteDef, url: URL, method: string): Record<string, string> {
  const ua = identity.userAgent ?? defaultUserAgent();
  const major = /Chrome\/(\d+)/.exec(ua)?.[1];
  const origin = new URL(site.origin).origin;
  const sameOrigin = url.origin === origin;
  const sameSite = sameOrigin || url.hostname.split(".").slice(-2).join(".") === new URL(origin).hostname.split(".").slice(-2).join(".");
  return {
    "user-agent": ua,
    ...(major
      ? {
          "sec-ch-ua": `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not_A Brand";v="99"`,
          "sec-ch-ua-mobile": /Mobile|Android/.test(ua) ? "?1" : "?0",
          "sec-ch-ua-platform": `"${platformOf(ua)}"`,
        }
      : {}),
    accept: "application/json, text/plain, */*",
    "accept-language": acceptLanguage(identity.languages ?? ["ru-RU", "ru", "en-US", "en"]),
    "sec-fetch-site": sameOrigin ? "same-origin" : sameSite ? "same-site" : "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    referer: `${origin}/`,
    // Chrome sends Origin on cross-origin requests and on non-GET ones.
    ...(!sameOrigin || (method !== "GET" && method !== "HEAD") ? { origin } : {}),
  };
}
