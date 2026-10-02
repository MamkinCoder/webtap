// Pure analysis for the mapper: which recorded response carries the data the page showed, and how to turn the
// recorded request into a template driven by the endpoint's inputs.
import type { RecordedExchange } from "../browser/cdp.js";

export type InputValue = string | number;

/** A string part, or a reference to an input (rendered as `i.<name>`). */
export type Part = string | { input: string; encode: "uri" | "raw" };

export interface RequestTemplate {
  method: string;
  url: Part[];
  headers: Record<string, string>;
  /** JSON body with inputs substituted, or a raw string body. */
  body?: { json: unknown } | { text: Part[] };
  /** Inputs that actually appear in the request. */
  usedInputs: string[];
}

export interface Candidate {
  exchange: RecordedExchange;
  json: unknown;
  score: number;
  matched: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** JSON responses only, re-serialised so \u escapes and spacing do not hide matches. */
export function parseJsonExchange(ex: RecordedExchange): unknown | undefined {
  const t = ex.body.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Ground-truth strings worth matching: long enough to be specific. */
export function truthStrings(items: Record<string, unknown>[]): string[] {
  const out = new Set<string>();
  for (const it of items) {
    for (const v of Object.values(it)) {
      if (typeof v === "string" && v.trim().length >= 4 && !/^https?:/.test(v)) out.add(norm(v));
    }
  }
  return [...out];
}

/** Ranks JSON responses by how many ground-truth strings they contain. */
export function rankCandidates(exchanges: RecordedExchange[], truths: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const exchange of exchanges) {
    if (exchange.status < 200 || exchange.status >= 300) continue;
    const json = parseJsonExchange(exchange);
    if (json === undefined) continue;
    const text = norm(JSON.stringify(json));
    const matched = truths.filter((t) => text.includes(t));
    if (matched.length) out.push({ exchange, json, score: matched.length, matched });
  }
  // More matches first; on a tie the smaller body (the specific API, not a page-wide state dump).
  return out.sort((a, b) => b.score - a.score || a.exchange.body.length - b.exchange.body.length);
}

// Headers the browser manages itself (or that identify this one session): never part of a recipe.
const DROP_HEADERS = /^(:|accept-encoding$|accept-language$|user-agent$|cookie$|connection$|host$|content-length$|priority$|sec-|upgrade-insecure-requests$|cache-control$|pragma$|if-none-match$|if-modified-since$)/i;

export function keepHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (!DROP_HEADERS.test(k)) out[k.toLowerCase()] = v;
  return out;
}

/** Splits `s` around occurrences of each input's sample value (raw, URI-encoded, form-encoded). */
function splitParts(s: string, inputs: Record<string, InputValue>, used: Set<string>): Part[] {
  type Hit = { at: number; len: number; input: string; encode: "uri" | "raw" };
  const hits: Hit[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    const raw = String(value);
    if (raw.length < 2) continue;
    const forms: [string, "uri" | "raw"][] = [
      [encodeURIComponent(raw), "uri"],
      [encodeURIComponent(raw).replace(/%20/g, "+"), "uri"],
      [raw, "raw"],
    ];
    for (const [form, encode] of forms) {
      let from = 0;
      for (;;) {
        const at = s.indexOf(form, from);
        if (at < 0) break;
        if (!hits.some((h) => at < h.at + h.len && h.at < at + form.length)) hits.push({ at, len: form.length, input: name, encode });
        from = at + form.length;
      }
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const parts: Part[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at > pos) parts.push(s.slice(pos, h.at));
    parts.push({ input: h.input, encode: h.encode });
    used.add(h.input);
    pos = h.at + h.len;
  }
  if (pos < s.length) parts.push(s.slice(pos));
  return parts;
}

/** Replaces values equal to an input's sample (strings, and numbers for numeric inputs) with input markers. */
function templateJson(v: unknown, inputs: Record<string, InputValue>, used: Set<string>): unknown {
  for (const [name, sample] of Object.entries(inputs)) {
    if (v === sample || (typeof sample === "number" && typeof v === "string" && v === String(sample))) {
      used.add(name);
      return { __input: name };
    }
  }
  if (Array.isArray(v)) return v.map((x) => templateJson(x, inputs, used));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, templateJson(x, inputs, used)]));
  return v;
}

export function toTemplate(ex: RecordedExchange, inputs: Record<string, InputValue>): RequestTemplate {
  const used = new Set<string>();
  const url = splitParts(ex.url, inputs, used);
  let body: RequestTemplate["body"];
  if (ex.postData !== undefined) {
    try {
      body = { json: templateJson(JSON.parse(ex.postData), inputs, used) };
    } catch {
      body = { text: splitParts(ex.postData, inputs, used) };
    }
  }
  const headers = keepHeaders(ex.requestHeaders);
  if (body && "json" in body) delete headers["content-type"]; // set by the runtime for JSON bodies
  return { method: ex.method, url, headers, ...(body ? { body } : {}), usedInputs: [...used] };
}

/** Renders a template back into a concrete request for given input values (used to verify it before codegen). */
export function fillTemplate(t: RequestTemplate, values: Record<string, InputValue>): { url: string; method: string; headers: Record<string, string>; body?: unknown } {
  const fill = (parts: Part[]) =>
    parts.map((p) => (typeof p === "string" ? p : p.encode === "uri" ? encodeURIComponent(String(values[p.input])) : String(values[p.input]))).join("");
  const fillJson = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fillJson);
    if (v && typeof v === "object") {
      if ("__input" in v) return values[(v as { __input: string }).__input];
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillJson(x)]));
    }
    return v;
  };
  return {
    url: fill(t.url),
    method: t.method,
    headers: t.headers,
    ...(t.body ? { body: "json" in t.body ? fillJson(t.body.json) : fill(t.body.text) } : {}),
  };
}

/** A small, representative slice of a JSON value for a prompt: arrays cut to 2 items, long strings cut. */
export function pruneJson(v: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (Array.isArray(v)) return [...v.slice(0, 2).map((x) => pruneJson(x, depth + 1)), ...(v.length > 2 ? [`… ${v.length - 2} more`] : [])];
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    const kept = entries.slice(0, 40).map(([k, x]) => [k, pruneJson(x, depth + 1)]);
    if (entries.length > 40) kept.push(["…", `${entries.length - 40} more keys`]);
    return Object.fromEntries(kept);
  }
  if (typeof v === "string" && v.length > 120) return `${v.slice(0, 120)}…`;
  return v;
}

// ── Request chains ───────────────────────────────────────────────────────────
// A data request often carries values the page got from earlier calls (a city id from a suggest call, listing ids
// from a search call). traceChain walks those back to a request that contains an input.

/** Id-like values in a request's query string and JSON body (numbers ≥ 1000, tokens with digits). */
export function requestValues(ex: RecordedExchange, inputs: Record<string, InputValue>): string[] {
  const out = new Set<string>();
  const samples = new Set(Object.values(inputs).map(String));
  const consider = (v: unknown) => {
    const s = String(v);
    if (samples.has(s)) return;
    if (/^\d{4,}$/.test(s) || (/^[\w-]{6,}$/.test(s) && /\d/.test(s) && /[a-z]/i.test(s))) out.add(s);
  };
  try {
    for (const [, v] of new URL(ex.url).searchParams) for (const part of v.split(/[;,]/)) consider(part);
  } catch {
    // not a url
  }
  if (ex.postData) {
    try {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
        else consider(v);
      };
      walk(JSON.parse(ex.postData));
    } catch {
      // form or text body
    }
  }
  return [...out];
}

/** Path to the first primitive equal to `value` (string or number), e.g. "data.items[0].id". */
export function findPath(json: unknown, value: string, path = "", depth = 0): string | undefined {
  if (depth > 12) return undefined;
  if (json === null || json === undefined) return undefined;
  if (typeof json !== "object") return String(json) === value ? path || "(root)" : undefined;
  if (Array.isArray(json)) {
    for (let i = 0; i < Math.min(json.length, 200); i++) {
      const p = findPath(json[i], value, `${path}[${i}]`, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(json)) {
    const p = findPath(v, value, path ? `${path}.${k}` : k, depth + 1);
    if (p) return p;
  }
  return undefined;
}

export interface ChainLink {
  value: string;
  /** Index into chain of the exchange whose response holds the value. */
  from: number;
  path: string;
  /** Index into chain of the exchange whose request uses it. */
  to: number;
}

export interface Chain {
  /** Ordered: first call first, the data request last. */
  exchanges: RecordedExchange[];
  links: ChainLink[];
  /** True when every input appears in some call of the chain. */
  reachesInputs: boolean;
}

const inputsIn = (ex: RecordedExchange, inputs: Record<string, InputValue>): Set<string> => {
  const used = new Set<string>();
  splitParts(ex.url, inputs, used);
  if (ex.postData) splitParts(ex.postData, inputs, used);
  return used;
};

export function traceChain(main: RecordedExchange, all: RecordedExchange[], inputs: Record<string, InputValue>, maxDepth = 3): Chain {
  const nodes: RecordedExchange[] = [main];
  const raw: { value: string; from: RecordedExchange; path: string; to: RecordedExchange }[] = [];
  const visit = (ex: RecordedExchange, depth: number) => {
    if (depth >= maxDepth) return;
    // Only responses that had fully arrived before this request was sent can have fed it.
    const before = all.filter((e) => e !== ex && e.finishedAt <= ex.startedAt).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const value of requestValues(ex, inputs)) {
      // Every earlier response holding the value; prefer one whose request carries an input this request lacks (where
      // the value originates, e.g. the suggest call for the typed city), else the latest one (closest to its use).
      const sources: { src: RecordedExchange; path: string }[] = [];
      for (const src of before) {
        const json = parseJsonExchange(src);
        const path = json === undefined ? undefined : findPath(json, value);
        if (path) sources.push({ src, path });
      }
      const own = inputsIn(ex, inputs);
      const pick = sources.find((c) => [...inputsIn(c.src, inputs)].some((k) => !own.has(k))) ?? sources.at(-1);
      if (!pick) continue;
      raw.push({ value, from: pick.src, path: pick.path, to: ex });
      if (!nodes.includes(pick.src)) {
        nodes.push(pick.src);
        visit(pick.src, depth + 1);
      }
    }
  };
  visit(main, 0);
  const exchanges = nodes.sort((a, b) => a.startedAt - b.startedAt);
  return {
    exchanges,
    links: raw.map((l) => ({ value: l.value, from: exchanges.indexOf(l.from), path: l.path, to: exchanges.indexOf(l.to) })),
    reachesInputs: Object.keys(inputs).every((k) => exchanges.some((e) => inputsIn(e, inputs).has(k))),
  };
}
