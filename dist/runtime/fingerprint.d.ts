import type { Identity, SiteDef } from "./site.js";
/** The installed Chrome's own reduced UA (cached), or a desktop Chrome UA of a recent version. */
export declare function defaultUserAgent(): string;
/** Accept-Language the way Chrome writes it: "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7". */
export declare function acceptLanguage(langs: string[]): string;
/**
 * Chrome's headers for an XHR/fetch to `url` from a page of `site`: user agent + matching client hints, fetch
 * metadata, referer (and origin when Chrome would send it). Recipe headers are applied on top.
 */
export declare function browserHeaders(identity: Identity, site: SiteDef, url: URL, method: string): Record<string, string>;
