// mapSite(): point it at a site with a goal and sample inputs; get back a reviewed-ready site file.
//
//   1. explore   an LLM drives the site (act steps, cached) until the goal's results show; all traffic is recorded
//   2. truth     the results are read off the page (extract) as ground truth
//   3. find      the recorded JSON response containing that ground truth is the data request
//   4. template  sample input values in its url/body become parameters
//   5. verify    the templated request is replayed over plain HTTP and from inside the tab
//   6. parse     the LLM writes the response → output mapping; it must reproduce the ground truth
//   7. render    a site file: verified strategies cheapest first, the explored steps as the browser fallback
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { installRecorder } from "../browser/cdp.js";
import { createLauncher } from "../browser/launcher.js";
import { encodeBody } from "../runtime/strategies.js";
import { errMessage } from "../types.js";
import { fillTemplate, parseJsonExchange, rankCandidates, toTemplate, traceChain, truthStrings } from "./analyze.js";
import { compileChain, describeChain, generateChain, generateParse, parseFields, renderSite, truthInstruction } from "./codegen.js";
import { explore } from "./explore.js";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** A ChainFetch over a transport: non-2xx and non-JSON answers throw, with the url, so the LLM can fix its calls. */
function jsonFetcher(send) {
    return async (req) => {
        const r = await send(req);
        if (r.status < 200 || r.status >= 300)
            throw new Error(`HTTP ${r.status} for ${req.method ?? "GET"} ${req.url.slice(0, 200)}: ${r.body.slice(0, 200)}`);
        try {
            return JSON.parse(r.body);
        }
        catch {
            throw new Error(`non-JSON answer for ${req.url.slice(0, 200)}: ${r.body.slice(0, 200)}`);
        }
    };
}
/** Does replaying the templated request still return the ground truth? */
async function verify(t, inputs, truths, via) {
    try {
        const req = fillTemplate(t, inputs);
        const res = await via(req);
        if (res.status < 200 || res.status >= 300)
            return undefined;
        const ex = { body: res.body, status: res.status };
        const json = parseJsonExchange(ex);
        if (json === undefined)
            return undefined;
        return rankCandidates([{ ...ex, url: req.url, method: req.method, type: "Fetch", requestHeaders: {}, mimeType: "" }], truths).length ? json : undefined;
    }
    catch {
        return undefined;
    }
}
export async function mapSite(o) {
    const log = o.log ?? (() => undefined);
    const fields = parseFields(o.fields);
    const start = new URL(o.url);
    const id = o.id ?? start.host.replace(/^www\./, "");
    const endpoint = o.endpoint ?? "search";
    const notes = [];
    const profile = await mkdtemp(join(tmpdir(), "webtap-map-"));
    const s = await createLauncher(o.browserLlm ?? o.llm).launch({
        headless: o.headless ?? true,
        userDataDir: profile,
        snapshotDir: join(profile, "snapshots"),
        blockAssets: true,
        ...(o.executablePath ? { executablePath: o.executablePath } : {}),
    });
    const wsUrl = s.cdpUrl?.();
    if (!wsUrl) {
        await s.close();
        throw new Error("the browser exposes no CDP url to record from");
    }
    const rec = await installRecorder(wsUrl);
    try {
        log(`exploring ${o.url}: ${o.goal}`);
        await s.goto(o.url);
        const ex = await explore(s, o.llm, { goal: o.goal, inputs: o.inputs, ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}), log });
        if (ex.blocked) {
            throw new Error(`${start.host} put up an anti-bot wall (${ex.blocked}) after ${ex.steps.length} step(s). ` +
                `Retry later or from another identity (proxy); nothing was generated.`);
        }
        if (!ex.done)
            notes.push(`the explorer did not confirm the goal (${ex.summary}); check the steps`);
        await sleep(2_000);
        log("reading the results off the page (ground truth)");
        const truthSchema = z.object({ items: z.array(z.object(Object.fromEntries(fields.map((f) => [f.name, z.string().optional()])))) });
        const truth = (await s.extract(truthInstruction(fields), truthSchema).catch(() => ({ items: [] }))).items;
        const truths = truthStrings(truth);
        log(`  ${truth.length} items on the page; ${rec.exchanges.length} responses recorded`);
        const ranked = rankCandidates(rec.exchanges, truths);
        const report = {
            explored: { steps: ex.steps.length, done: ex.done, summary: ex.summary },
            truth,
            recorded: rec.exchanges.length,
            candidates: ranked.slice(0, 5).map((c) => ({ url: c.exchange.url.slice(0, 200), method: c.exchange.method, score: c.score })),
            notes,
        };
        let request;
        let chain;
        for (const c of ranked.slice(0, 3)) {
            if (c.score < Math.min(2, truths.length))
                break;
            const t = toTemplate(c.exchange, o.inputs);
            log(`candidate ${c.exchange.method} ${c.exchange.url.slice(0, 120)} (matches ${c.score})`);
            const viaHttp = await verify(t, o.inputs, truths, async (req) => {
                const { body, headers } = encodeBody({ url: req.url, ...(req.body !== undefined ? { body: req.body } : {}), headers: req.headers });
                const r = await fetch(req.url, { method: req.method, headers: { "user-agent": UA, "accept-language": "ru-RU,ru,en-US,en", ...headers }, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(20_000) });
                return { status: r.status, body: await r.text() };
            });
            const viaPage = await verify(t, o.inputs, truths, async (req) => {
                const { body, headers } = encodeBody({ url: req.url, ...(req.body !== undefined ? { body: req.body } : {}), headers: req.headers });
                return s.fetch(req.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}) });
            });
            log(`  replay: http ${viaHttp ? "✓" : "✗"}, page-fetch ${viaPage ? "✓" : "✗"}`);
            if (!viaHttp && !viaPage)
                continue;
            const missing = Object.keys(o.inputs).filter((k) => !t.usedInputs.includes(k));
            if (missing.length) {
                // The data request carries ids the page got from earlier calls: follow them back to the inputs.
                const traced = traceChain(c.exchange, rec.exchanges, o.inputs);
                log(`  ${missing.join(", ")} not in the data request; traced a chain of ${traced.exchanges.length} call(s)${traced.reachesInputs ? "" : " (does not reach every input)"}`);
                if (traced.reachesInputs && traced.exchanges.length > 1) {
                    const viaHttpJson = jsonFetcher(async (req) => {
                        const { body, headers } = encodeBody({ url: req.url, ...(req.body !== undefined ? { body: req.body } : {}), ...(req.headers ? { headers: req.headers } : {}) });
                        const r = await fetch(new URL(req.url, start.origin), { method: req.method ?? (body === undefined ? "GET" : "POST"), headers: { "user-agent": UA, "accept-language": "ru-RU,ru,en-US,en", accept: "application/json, text/plain, */*", ...headers }, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(20_000) });
                        return { status: r.status, body: await r.text() };
                    });
                    const viaPageJson = jsonFetcher(async (req) => {
                        const { body, headers } = encodeBody({ url: req.url, ...(req.body !== undefined ? { body: req.body } : {}), ...(req.headers ? { headers: req.headers } : {}) });
                        return s.fetch(new URL(req.url, start.origin).toString(), { ...(req.method ? { method: req.method } : {}), headers, ...(body !== undefined ? { body } : {}) });
                    });
                    const base = { goal: o.goal, origin: start.origin, fields, chain: traced, truth, input: o.inputs };
                    for (const [via, fetchJson] of [["http", viaHttpJson], ["page", viaPageJson]]) {
                        log(`writing the request chain (${via})`);
                        try {
                            const gen = await generateChain(o.llm, { ...base, fetchJson });
                            // Does the other transport run the same code?
                            const other = via === "http" ? viaPageJson : viaHttpJson;
                            const otherOk = await compileChain(gen.code)({ ...o.inputs, limit: 10 }, other).then((r) => !!r.items?.length, () => false);
                            const http = via === "http" || otherOk;
                            const pageFetch = via === "page" || otherOk;
                            chain = { code: gen.code, http, pageFetch, calls: describeChain(traced).map((d) => d.split("\n")[0]) };
                            report.chosen = { url: c.exchange.url.slice(0, 200), method: c.exchange.method, http, pageFetch, usedInputs: Object.keys(o.inputs), parsedItems: gen.items.length, truthMatched: gen.truthMatched, chainCalls: traced.exchanges.length };
                            log(`  chain ok: ${gen.items.length} items, ${gen.truthMatched} match the page (http ${http ? "✓" : "✗"}, page-fetch ${pageFetch ? "✓" : "✗"})`);
                            break;
                        }
                        catch (err) {
                            notes.push(`request chain (${via}) failed: ${errMessage(err).slice(0, 300)}`);
                        }
                    }
                    if (chain)
                        break;
                }
                notes.push(`input(s) ${missing.join(", ")} do not appear in the data request and no working call chain was found. ` +
                    `As generated, the request is fixed to the sample value; wire the lookup in by hand or rely on the browser strategy.`);
            }
            log("writing the parse function");
            try {
                const gen = await generateParse(o.llm, { goal: o.goal, origin: start.origin, fields, json: c.json, truth, input: { ...o.inputs, limit: 10 } });
                request = { template: t, http: !!viaHttp, pageFetch: !!viaPage, parseCode: gen.code, recordedUrl: c.exchange.url };
                report.chosen = { url: c.exchange.url.slice(0, 200), method: c.exchange.method, http: !!viaHttp, pageFetch: !!viaPage, usedInputs: t.usedInputs, parsedItems: gen.items.length, truthMatched: gen.truthMatched };
                log(`  parse ok: ${gen.items.length} items, ${gen.truthMatched} match the page`);
                break;
            }
            catch (err) {
                notes.push(`parse codegen failed for ${c.exchange.url.slice(0, 120)}: ${errMessage(err)}`);
            }
        }
        if (!request && !chain)
            notes.push("no replayable data request found: the recipe has only the browser strategy (LLM extract, slow)");
        const source = renderSite({
            id,
            endpoint,
            goal: o.goal,
            origin: start.origin,
            startUrl: o.url,
            inputs: o.inputs,
            fields,
            ...(chain ? { chain } : request ? { request } : {}),
            steps: ex.steps.filter((st) => st.ok).map((st) => ({ kind: st.kind, value: st.value })),
            date: new Date().toISOString().slice(0, 10),
            notes,
        });
        return { source, report };
    }
    finally {
        rec.stop();
        await s.close();
        await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    }
}
export { parseFields } from "./codegen.js";
//# sourceMappingURL=index.js.map