export class StrategyFailure extends Error {
    outcome;
    constructor(outcome, message) {
        super(message);
        this.outcome = outcome;
        this.name = "StrategyFailure";
    }
}
export const banned = (message) => new StrategyFailure("banned", message);
export const changed = (message) => new StrategyFailure("changed", message);
export const transient = (message) => new StrategyFailure("error", message);
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
export const looksLikeChallenge = (r) => BAN_MARKERS.some((re) => re.test(r.url) || re.test(r.body.slice(0, 20_000)));
/** null = a usable response. */
export function classifyResponse(r) {
    const where = `${r.status} from ${hostOf(r.url)}`;
    if (BAN_STATUSES.has(r.status))
        return banned(`HTTP ${where}`);
    if (CHANGED_STATUSES.has(r.status))
        return changed(`HTTP ${where}`);
    if (r.status >= 500)
        return looksLikeChallenge(r) ? banned(`HTTP ${where} (challenge page)`) : transient(`HTTP ${where}`);
    if (r.status >= 400)
        return changed(`HTTP ${where}`);
    return null;
}
/** JSON body of a usable response; a challenge page or non-JSON becomes banned / changed. */
export function parseJsonBody(r) {
    const bad = classifyResponse(r);
    if (bad)
        throw bad;
    try {
        return JSON.parse(r.body);
    }
    catch {
        if (looksLikeChallenge(r))
            throw banned(`challenge page instead of JSON from ${hostOf(r.url)}`);
        throw changed(`non-JSON response from ${hostOf(r.url)} (${r.contentType || "no content-type"}): ${r.body.slice(0, 120)}`);
    }
}
const hostOf = (url) => {
    try {
        return new URL(url).host;
    }
    catch {
        return url;
    }
};
//# sourceMappingURL=outcome.js.map