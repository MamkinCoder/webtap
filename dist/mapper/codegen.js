// Mapper codegen: the output fields, an LLM-written parse function validated against the recorded response, and the
// site file (TypeScript) a human reviews and commits.
import { z } from "zod";
import { keepHeaders, parseJsonExchange, pruneJson } from "./analyze.js";
/** "title:string,priceRub:number?,url" → specs (type defaults to string, "?" = optional). */
export function parseFields(spec) {
    const fields = spec
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
        const m = /^([A-Za-z_$][\w$]*)(?::(string|number|boolean))?(\?)?$/.exec(s);
        if (!m)
            throw new Error(`bad field "${s}": expected name[:string|number|boolean][?]`);
        return { name: m[1], type: (m[2] ?? "string"), optional: !!m[3] };
    });
    if (!fields.length)
        throw new Error("at least one output field is required");
    return fields;
}
export function itemSchema(fields) {
    const shape = {};
    for (const f of fields) {
        const base = f.type === "number" ? z.number() : f.type === "boolean" ? z.boolean() : z.string();
        shape[f.name] = f.optional ? base.optional() : base;
    }
    return z.object(shape);
}
const fieldsText = (fields) => fields.map((f) => `${f.name}: ${f.type}${f.optional ? " (optional)" : ""}`).join(", ");
const stripFences = (s) => {
    const m = /```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/.exec(s);
    return (m?.[1] ?? s).trim().replace(/;\s*$/, "");
};
/** Compiles an arrow function from source. The code is the mapper's own LLM output, run locally on recorded data. */
export function compileParse(code) {
    const fn = new Function(`"use strict"; return (${code});`)();
    if (typeof fn !== "function")
        throw new Error("the code is not a function expression");
    return fn;
}
const normText = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
/** Asks the LLM for a parse function and checks it on the recorded response; feeds errors back, up to `attempts`. */
export async function generateParse(llm, g, attempts = 3) {
    const schema = z.object({ items: z.array(itemSchema(g.fields)).min(1) });
    const firstField = g.fields.find((f) => f.type === "string")?.name;
    const truthTitles = firstField ? g.truth.map((t) => normText(t[firstField])).filter((t) => t.length >= 3) : [];
    const sample = JSON.stringify(pruneJson(g.json), null, 1).slice(0, 12_000);
    const messages = [
        {
            role: "user",
            content: [
                `Goal of the endpoint: ${g.goal}`,
                `Site origin: ${g.origin}`,
                `Endpoint input (sample values): ${JSON.stringify(g.input)}`,
                `Output: { items: Item[] } where Item = { ${fieldsText(g.fields)} }`,
                `What the page showed for this input (ground truth, as text): ${JSON.stringify(g.truth.slice(0, 4))}`,
                `A pruned sample of the JSON response (arrays cut to 2 items):\n${sample}`,
                "",
                "Write ONE JavaScript arrow function `(json, input) => ({ items: [...] })` that maps this response to the output.",
                "- Map every result in the response, in order, not just the first ones.",
                "- Use optional chaining; drop items missing a required field instead of throwing.",
                "- Numbers must be numbers. Prices in rubles: if the response stores kopecks/cents (100x the page's price), divide.",
                `- Make relative urls absolute against ${g.origin}. Build image urls from templates if the response has them.`,
                "- Plain JavaScript (no TypeScript), no imports, no comments needed. Return only the function, no prose, no code fences.",
            ].join("\n"),
        },
    ];
    let lastError = "";
    for (let i = 0; i < attempts; i++) {
        const res = await llm.generate({ messages, systemPrompt: "You write small, defensive JavaScript data-mapping functions.", temperature: 0 });
        const code = stripFences(res.text);
        try {
            const out = compileParse(code)(g.json, g.input);
            const parsed = schema.safeParse(out);
            if (!parsed.success)
                throw new Error(`output does not match { items: Item[] } (non-empty): ${parsed.error.message.slice(0, 600)}`);
            const items = parsed.data.items;
            const got = firstField ? items.map((it) => normText(it[firstField])) : [];
            const truthMatched = truthTitles.filter((t) => got.some((x) => x.includes(t) || t.includes(x))).length;
            if (truthTitles.length && truthMatched === 0) {
                throw new Error(`none of the page's items came out (expected e.g. ${JSON.stringify(truthTitles.slice(0, 2))}, got ${JSON.stringify(got.slice(0, 3))})`);
            }
            return { code, items, truthMatched };
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            messages.push({ role: "assistant", content: code }, { role: "user", content: `That failed: ${lastError}\nFix it. Return only the function.` });
        }
    }
    throw new Error(`could not generate a working parse function: ${lastError}`);
}
export const truthInstruction = (fields) => `Up to 5 of the result items currently shown on the page, with these fields as shown (text): ${fieldsText(fields)}`;
/** Describes the recorded calls and how values flowed between them, for the prompt and the file's comment. */
export function describeChain(chain) {
    return chain.exchanges.map((e, i) => {
        const headers = keepHeaders(e.requestHeaders);
        const json = parseJsonExchange(e);
        const uses = chain.links.filter((l) => l.to === i);
        const usedOnce = [...new Map(uses.map((l) => [`${l.from}:${l.path.replace(/\[\d+\]/g, "[*]")}`, l])).values()];
        return [
            `#${i} ${e.method} ${decodeURIComponent(e.url)}`,
            Object.keys(headers).length ? `   headers: ${JSON.stringify(headers)}` : "",
            e.postData ? `   body: ${e.postData.slice(0, 1500)}` : "",
            ...usedOnce.map((l) => `   uses ${l.value}${uses.filter((u) => u.path.replace(/\[\d+\]/g, "[*]") === l.path.replace(/\[\d+\]/g, "[*]")).length > 1 ? " (and the other items)" : ""} from #${l.from} response at ${l.path}`),
            `   response (pruned): ${JSON.stringify(pruneJson(json)).slice(0, 3_500)}`,
        ]
            .filter(Boolean)
            .join("\n");
    });
}
/** Compiles an async arrow function from source (the mapper's own LLM output). */
export function compileChain(code) {
    const fn = new Function(`"use strict"; return (${code});`)();
    if (typeof fn !== "function")
        throw new Error("the code is not a function expression");
    return fn;
}
/** Asks the LLM to wire the recorded call chain; runs it for real and checks it reproduces the page. */
export async function generateChain(llm, g, attempts = 3) {
    const schema = z.object({ items: z.array(itemSchema(g.fields)).min(1) });
    const firstField = g.fields.find((f) => f.type === "string")?.name;
    const truthTitles = firstField ? g.truth.map((t) => normText(t[firstField])).filter((t) => t.length >= 3) : [];
    const messages = [
        {
            role: "user",
            content: [
                `Goal of the endpoint: ${g.goal}`,
                `Site origin: ${g.origin}`,
                `Endpoint input (sample values used in the recording): ${JSON.stringify(g.input)}`,
                `Output: { items: Item[] } where Item = { ${fieldsText(g.fields)} }`,
                `What the page showed (ground truth, as text): ${JSON.stringify(g.truth.slice(0, 4))}`,
                `The site's own frontend made these calls, in order; later calls use values from earlier responses:`,
                ...describeChain(g.chain),
                "",
                "Write ONE JavaScript async arrow function `async (input, fetchJson) => ({ items: [...] })` that reproduces this chain for any input.",
                "- fetchJson({ url, method?, headers?, body? }) makes a request (url absolute or relative to the origin; an object body is sent as JSON) and resolves to the parsed JSON.",
                "- Put input values where the sample values were (encodeURIComponent in urls). Keep the other recorded parameters as they were.",
                "- Take ids, coordinates and bounding boxes from the earlier responses (as the 'uses' lines show), not from the recording.",
                "- When a call takes a list of ids from an earlier response, pass up to (input.limit ?? 10) of them.",
                "- Map the final response to items: numbers as numbers, prices in rubles, absolute urls, image urls built from templates if needed.",
                "- Plain JavaScript (no TypeScript), no imports. Return only the function, no prose, no code fences.",
            ].join("\n"),
        },
    ];
    let lastError = "";
    for (let i = 0; i < attempts; i++) {
        const res = await llm.generate({ messages, systemPrompt: "You write small, defensive JavaScript API clients.", temperature: 0 });
        const code = stripFences(res.text);
        try {
            const out = await compileChain(code)({ ...g.input, limit: 10 }, g.fetchJson);
            const parsed = schema.safeParse(out);
            if (!parsed.success)
                throw new Error(`output does not match { items: Item[] } (non-empty): ${parsed.error.message.slice(0, 600)}`);
            const items = parsed.data.items;
            const got = firstField ? items.map((it) => normText(it[firstField])) : [];
            const truthMatched = truthTitles.filter((t) => got.some((x) => x.includes(t) || t.includes(x))).length;
            if (truthTitles.length && truthMatched === 0) {
                throw new Error(`none of the page's items came out (expected e.g. ${JSON.stringify(truthTitles.slice(0, 2))}, got ${JSON.stringify(got.slice(0, 3))})`);
            }
            return { code, items, truthMatched };
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            messages.push({ role: "assistant", content: code }, { role: "user", content: `Running it failed: ${lastError.slice(0, 1500)}\nFix it. Return only the function.` });
        }
    }
    throw new Error(`could not generate a working request chain: ${lastError}`);
}
// ── Rendering ────────────────────────────────────────────────────────────────
/**
 * Makes LLM-written JavaScript pass strict TypeScript: plain parameters of arrow functions and function expressions
 * get `: any` (`o => …` → `(o: any) => …`, `(a, b) =>` → `(a: any, b: any) =>`). Destructured, defaulted and rest
 * parameters are left alone. Validation runs the original JavaScript; only the rendered file is annotated.
 */
export function annotateAny(code) {
    const simpleList = (params) => {
        const names = params.split(",").map((p) => p.trim());
        if (!names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n)))
            return undefined;
        return names.map((n) => `${n}: any`).join(", ");
    };
    return code
        .replace(/\(([^()]*)\)(\s*=>)/g, (m, params, arrow) => {
        if (!params.trim())
            return m;
        const typed = simpleList(params);
        return typed ? `(${typed})${arrow}` : m;
    })
        .replace(/(^|[^\w$.)\]'"`])([A-Za-z_$][\w$]*)(\s*=>)/g, (m, pre, name, arrow) => name === "async" ? m : `${pre}(${name}: any)${arrow}`)
        .replace(/(\bfunction\b\s*[\w$]*\s*)\(([^()]*)\)/g, (m, head, params) => {
        if (!params.trim())
            return m;
        const typed = simpleList(params);
        return typed ? `${head}(${typed})` : m;
    });
}
const ident = (s) => s.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^(\d)/, "_$1");
const camel = (s) => ident(s.replace(/[-_.\s]+(\w)/g, (_, c) => c.toUpperCase()));
const tick = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
function renderParts(parts) {
    return "`" + parts.map((p) => (typeof p === "string" ? tick(p) : p.encode === "uri" ? `\${encodeURIComponent(String(i.${p.input}))}` : `\${i.${p.input}}`)).join("") + "`";
}
function renderJson(v, indent) {
    if (v && typeof v === "object" && !Array.isArray(v) && "__input" in v)
        return `i.${v.__input}`;
    if (Array.isArray(v))
        return v.length ? `[${v.map((x) => renderJson(x, indent)).join(", ")}]` : "[]";
    if (v && typeof v === "object") {
        const entries = Object.entries(v);
        if (!entries.length)
            return "{}";
        const inner = indent + "  ";
        return `{\n${entries.map(([k, x]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${renderJson(x, inner)},`).join("\n")}\n${indent}}`;
    }
    return JSON.stringify(v);
}
/** A url with %name% placeholders → a template literal filling them from the input. */
function placeholderUrl(url) {
    if (!/%[A-Za-z_$][\w$]*%/.test(url))
        return JSON.stringify(url);
    return "`" + tick(url).replace(/%([A-Za-z_$][\w$]*)%/g, (_, k) => `\${encodeURIComponent(String(i.${k}))}`) + "`";
}
export function renderSite(r) {
    const name = camel(r.id);
    const inputLines = Object.entries(r.inputs).map(([k, v]) => `  ${k}: ${typeof v === "number" ? "z.number()" : "z.string().min(1)"},`);
    const fieldLines = r.fields.map((f) => `  ${f.name}: z.${f.type}()${f.optional ? ".optional()" : ""},`);
    const strategies = [];
    const imports = new Set(["defineSite", "endpoint", "z"]);
    let requestBlock = "";
    if (r.request) {
        const t = r.request.template;
        const lines = [`  url: ${renderParts(t.url)},`];
        if (t.method !== "GET")
            lines.push(`  method: ${JSON.stringify(t.method)},`);
        if (Object.keys(t.headers).length)
            lines.push(`  headers: ${renderJson(t.headers, "  ")},`);
        if (t.body)
            lines.push(`  body: ${"json" in t.body ? renderJson(t.body.json, "  ") : renderParts(t.body.text)},`);
        imports.add("type HttpRequest");
        requestBlock = [
            `// Recorded from the site's own frontend: ${t.method} ${r.request.recordedUrl.slice(0, 200)}`,
            `const request = (i: Input): HttpRequest => ({`,
            ...lines,
            `});`,
            ``,
            `// Written by the mapper's LLM from the recorded response and checked against it (${r.date}). Review it.`,
            `const parseRaw: (json: any, input: Input) => { items?: unknown[] } = ${annotateAny(r.request.parseCode)};`,
            `const parse = (json: any, i: Input) => ({ items: (parseRaw(json, i).items ?? []).slice(0, i.limit) as Item[] });`,
            ``,
        ].join("\n");
        if (r.request.http) {
            imports.add("http");
            strategies.push(`          http({ request, parse }),`);
        }
        if (r.request.pageFetch) {
            imports.add("pageFetch");
            strategies.push(`          pageFetch({ warmUrl: ${JSON.stringify(new URL(r.startUrl).pathname || "/")}, request, parse }),`);
        }
    }
    if (r.chain) {
        imports.add("requests");
        imports.add("type FetchJson");
        requestBlock = [
            `// Recorded call chain (the site's own frontend):`,
            ...r.chain.calls.map((c) => `//   ${c.slice(0, 180)}`),
            `// Wired by the mapper's LLM and run against the live site with the sample input (${r.date}). Review it.`,
            `const runChain: (input: Input, fetchJson: FetchJson) => Promise<{ items?: unknown[] }> = ${annotateAny(r.chain.code)};`,
            `const run = async (i: Input, fetchJson: FetchJson) => ({ items: ((await runChain(i, fetchJson)).items ?? []).slice(0, i.limit) as Item[] });`,
            ``,
        ].join("\n");
        if (r.chain.http)
            strategies.push(`          requests({ run }),`);
        if (r.chain.pageFetch)
            strategies.push(`          requests({ via: "page", warmUrl: ${JSON.stringify(new URL(r.startUrl).pathname || "/")}, run }),`);
    }
    // Browser fallback: replay the explorer's steps (selectors cached + healed by webtap), read the results with the LLM.
    imports.add("browser");
    const vars = `{ ${Object.keys(r.inputs).map((k) => `${k}: String(i.${k})`).join(", ")} }`;
    const stepLines = r.steps.map((s, n) => s.kind === "goto"
        ? `              await s.goto(${placeholderUrl(s.value)});`
        : `              await s.act(${JSON.stringify(s.value)}, { cacheKey: ${JSON.stringify(`${r.endpoint}.step${n + 1}`)}, variables: ${vars} });`);
    strategies.push([
        `          browser({`,
        `            run: async (s, i) => {`,
        `              await s.goto(${JSON.stringify(r.startUrl)});`,
        ...stepLines,
        `              const out = await s.extract(${JSON.stringify(`The result items shown on the page for: ${r.goal}`)}, z.object({ items: z.array(Item) }));`,
        `              return { items: out.items.slice(0, i.limit) };`,
        `            },`,
        `          }),`,
    ].join("\n"));
    const canary = Object.fromEntries(Object.entries(r.inputs).map(([k, v]) => [k, v]));
    return [
        `// ${r.id}: ${r.goal}`,
        `//`,
        `// Generated by \`webtap map\` on ${r.date} from ${r.startUrl}. Review before committing:`,
        `// the request and parse function come from one recorded run of the site's frontend.`,
        ...r.notes.map((n) => `// NOTE: ${n}`),
        `import { ${[...imports].sort((a, b) => a.replace("type ", "").localeCompare(b.replace("type ", ""))).join(", ")} } from "@mamkincoder/webtap";`,
        ``,
        `const Input = z.object({`,
        ...inputLines,
        `  limit: z.number().int().min(1).max(50).default(10),`,
        `});`,
        `type Input = z.output<typeof Input>;`,
        ``,
        `const Item = z.object({`,
        ...fieldLines,
        `});`,
        `type Item = z.output<typeof Item>;`,
        ``,
        requestBlock,
        `export const ${name} = defineSite({`,
        `  id: ${JSON.stringify(r.id)},`,
        `  origin: ${JSON.stringify(r.origin)},`,
        `  rateLimit: { minIntervalMs: 2_000 },`,
        `  endpoints: {`,
        `    ${ident(r.endpoint)}: endpoint(`,
        `      { description: ${JSON.stringify(r.goal)}, input: Input, output: z.object({ items: z.array(Item) }) },`,
        `      {`,
        `        strategies: [`,
        ...strategies,
        `        ],`,
        `        canary: { input: ${JSON.stringify(canary)} },`,
        `      },`,
        `    ),`,
        `  },`,
        `});`,
        ``,
    ].join("\n");
}
//# sourceMappingURL=codegen.js.map