// Every failed attempt is one of three things, and each needs a different fix:
//   banned  — this identity is blocked (403/429/498, captcha or challenge page): quarantine it, try another identity.
//   changed — the site answered but not in the shape we expect (404, wrong JSON, verify failed): next strategy;
//             failing on every healthy identity means the recipe needs re-mapping.
//   error   — transient (timeout, 5xx, network): next identity / strategy, counts toward the circuit breaker.
import type { HttpResponse } from "./site.js";

export type Outcome = "ok" | "banned" | "changed" | "error";

export class StrategyFailure extends Error {
  constructor(
    public readonly outcome: Exclude<Outcome, "ok">,
    message: string,
  ) {
    super(message);
    this.name = "StrategyFailure";
  }
}

export const banned = (message: string) => new StrategyFailure("banned", message);
export const changed = (message: string) => new StrategyFailure("changed", message);
export const transient = (message: string) => new StrategyFailure("error", message);

const BAN_STATUSES = new Set([403, 429, 498]);
const CHANGED_STATUSES = new Set([404, 405, 410]);
// Anti-bot pages that answer 200: challenges, captchas, WAF blocks.
const BAN_MARKERS = [
  /showcaptcha|smartcaptcha/i, // Yandex
  /__wbaas\/challenges/i, // Wildberries
  /cf-chl|challenge-platform|cf_chl_opt/i, // Cloudflare
  /ddos-guard/i,
  /qrator/i,
  /captcha/i,
  /access denied|доступ (?:ограничен|запрещ)/i,
];

export const looksLikeChallenge = (r: Pick<HttpResponse, "url" | "body">): boolean =>
  BAN_MARKERS.some((re) => re.test(r.url) || re.test(r.body.slice(0, 20_000)));

/** null = a usable response. */
export function classifyResponse(r: HttpResponse): StrategyFailure | null {
  const where = `${r.status} from ${hostOf(r.url)}`;
  if (BAN_STATUSES.has(r.status)) return banned(`HTTP ${where}`);
  if (CHANGED_STATUSES.has(r.status)) return changed(`HTTP ${where}`);
  if (r.status >= 500) return looksLikeChallenge(r) ? banned(`HTTP ${where} (challenge page)`) : transient(`HTTP ${where}`);
  if (r.status >= 400) return changed(`HTTP ${where}`);
  return null;
}

/** JSON body of a usable response; a challenge page or non-JSON becomes banned / changed. */
export function parseJsonBody(r: HttpResponse): unknown {
  const bad = classifyResponse(r);
  if (bad) throw bad;
  try {
    return JSON.parse(r.body);
  } catch {
    if (looksLikeChallenge(r)) throw banned(`challenge page instead of JSON from ${hostOf(r.url)}`);
    throw changed(`non-JSON response from ${hostOf(r.url)} (${r.contentType || "no content-type"}): ${r.body.slice(0, 120)}`);
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
