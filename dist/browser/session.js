// BrowserSession over Stagehand v4. Natural-language act() goes cache → replay → observe → act;
// everything else is deterministic Page/Locator/evaluate calls (no LLM).
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errMessage } from "../types.js";
import { hostOf } from "./cache.js";
import { chromiumTreeRssMB, killChromiumLeftovers } from "./memory.js";
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
/** LLM-backed steps (observe/extract) include one or more model calls (3–8 s each through `claude -p`). */
const LLM_STEP_TIMEOUT_MS = 120_000;
const NETWORK_IDLE_MS = 3_000;
// Runs in the page. `sel` is css, or xpath when it starts with "/" or "xpath=" (Stagehand's rule).
export const RESOLVE_JS = `(function(sel){
  if (sel.startsWith("xpath=")) sel = sel.slice(6);
  if (sel.startsWith("/") || sel.startsWith("(")) return document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  return document.querySelector(sel);
})`;
export const fillJs = (selector, value) => `(function(){
  var el = ${RESOLVE_JS}(${JSON.stringify(selector)});
  if (!el) return false;
  var v = ${JSON.stringify(value)};
  el.focus && el.focus();
  if (el.isContentEditable) { el.textContent = v; el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" })); return true; }
  var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, v); else el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value === v;
})()`;
// A mouse click lands on whatever is on top at the element's centre: an open modal, its overlay, a cookie banner. The
// click then "succeeds" on the wrong element (corp.ivi.ru: the submit click closed a popup and the form never left
// data-status=init). Hit-tests the target first; when something else covers it, clicks the element through the DOM.
// "clear" = the mouse click would hit it (or it is not in this document / has no box): Stagehand clicks as usual.
export const coveredClickJs = (selector) => `(function(){
  var el = ${RESOLVE_JS}(${JSON.stringify(selector)});
  if (!el || !el.getBoundingClientRect) return "clear";
  var r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { el.scrollIntoView({ block: "center" }); r = el.getBoundingClientRect(); }
  if (!r.width || !r.height) return "clear";
  var top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!top || top === el || el.contains(top)) return "clear";
  var lbl = top.closest && top.closest("label");
  if (lbl && lbl.control === el) return "clear";
  el.click();
  return "covered by " + top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") + (typeof top.className === "string" && top.className ? "." + top.className.trim().split(/\\s+/).join(".") : "");
})()`;
// Centre + size of an element after scrolling it to the middle of the viewport; null when missing or boxless.
const boxJs = (selector) => `(function(){
  var el = ${RESOLVE_JS}(${JSON.stringify(selector)});
  if (!el || !el.getBoundingClientRect) return null;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  var r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2, top = document.elementFromPoint(cx, cy);
  return { x: cx, y: cy, w: r.width, h: r.height, covered: !!top && top !== el && !el.contains(top) };
})()`;
// The field's value; focus() + select() so a Backspace clears it. Null when missing or not a text field.
const selectValueJs = (selector) => `(function(){
  var el = ${RESOLVE_JS}(${JSON.stringify(selector)});
  if (!el || typeof el.value !== "string") return null;
  el.focus();
  if (el.select) el.select();
  return el.value;
})()`;
const valueJs = (selector) => `(function(){ var el = ${RESOLVE_JS}(${JSON.stringify(selector)}); return el && typeof el.value === "string" ? el.value : null; })()`;
const norm = (v) => v.replace(/\r\n/g, "\n").trim();
const rnd = (a, b) => a + Math.random() * (b - a);
// fetch() in the page context: same-origin cookies, the browser's TLS fingerprint and whatever tokens the site's own
// scripts set. Relative urls resolve against the current page.
export const pageFetchJs = (url, init) => `(async function(){
  var r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(init.method ?? "GET")}, headers: ${JSON.stringify(init.headers ?? {})}, body: ${init.body === undefined ? "undefined" : JSON.stringify(init.body)}, credentials: "include" });
  return { status: r.status, url: r.url, contentType: r.headers.get("content-type") || "", body: await r.text() };
})()`;
export const TEXT_JS = (max) => `(document.body ? document.body.innerText : "").slice(0, ${max})`;
export class StagehandSession {
    d;
    closing;
    mouse = { x: rnd(300, 900), y: rnd(200, 600) };
    constructor(d) {
        this.d = d;
    }
    get page() {
        return this.d.page;
    }
    get actionTimeout() {
        return this.d.opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    }
    async goto(url, opts) {
        // DOM ready is all the parsers need (InitialState templates); a hung tracker must not fail the run.
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(this.actionTimeout, 30_000) });
        if (opts?.quick)
            return;
        try {
            await this.page.waitForLoadState("load", 15_000);
        }
        catch {
            // bounded wait only
        }
        try {
            await this.page.waitForLoadState("networkidle", NETWORK_IDLE_MS);
        }
        catch {
            // bounded wait only; a chatty page must not block the run
        }
    }
    url() {
        return this.page.url();
    }
    cdpUrl() {
        return this.d.cdpUrl;
    }
    html() {
        return this.page.evaluate("document.documentElement.outerHTML");
    }
    text(maxChars = 20_000) {
        return this.page.evaluate(TEXT_JS(maxChars));
    }
    async act(instruction, opts = {}) {
        const timeout = opts.timeoutMs ?? this.actionTimeout;
        const host = hostOf(await this.url());
        const key = opts.cacheKey ?? instruction;
        const tryCached = async () => {
            const cached = this.d.cache.get(host, key);
            if (!cached)
                return undefined;
            const replay = await this.replay(cached, opts.variables, timeout);
            if (replay.ok) {
                this.d.cache.success(host, key, cached);
                return { success: true, message: replay.message, usedCache: true, selector: cached.selector };
            }
            this.d.cache.failure(host, key);
            return undefined;
        };
        const fromCache = await tryCached();
        if (fromCache)
            return fromCache;
        // Heal (or first lookup): one observe for this step across all sessions; the others replay its result.
        const healed = await this.d.cache.heal(host, key, () => this.observeAndRun(instruction, host, key, opts.variables, timeout));
        if (healed.ran)
            return healed.value;
        return (await tryCached()) ?? this.observeAndRun(instruction, host, key, opts.variables, timeout);
    }
    async observeAndRun(instruction, host, key, variables, timeout) {
        const observed = await this.observeRaw(instruction, variables, Math.max(timeout, LLM_STEP_TIMEOUT_MS));
        const first = observed[0];
        if (!first)
            return { success: false, message: `observe found nothing for: ${instruction}`, usedCache: false };
        const action = { selector: first.selector, description: first.description, method: first.method ?? "click", arguments: first.arguments ?? [] };
        const run = await this.replay(action, variables, timeout);
        if (run.ok)
            this.d.cache.success(host, key, action);
        else
            this.d.cache.invalidate(host, key);
        return { success: run.ok, message: run.message, usedCache: false, selector: action.selector };
    }
    /** Deterministic Stagehand act on a known Action: xpath resolution + method dispatch, `%var%` substitution, no LLM. */
    async replay(entry, variables, timeout) {
        try {
            if (entry.method === "click") {
                const hit = await this.page.evaluate(coveredClickJs(entry.selector)).catch(() => "clear");
                if (hit !== "clear")
                    return { ok: true, message: `${hit}: clicked through the DOM` };
            }
            const res = await this.d.stagehand.act({ selector: entry.selector, description: entry.description, method: entry.method, arguments: entry.arguments }, { timeout, ...(variables ? { variables } : {}) });
            return { ok: res.data.success, message: res.data.message };
        }
        catch (err) {
            return { ok: false, message: errMessage(err) };
        }
    }
    async observeRaw(instruction, variables, timeout) {
        const res = await this.d.stagehand.observe(instruction, { timeout, ...(variables ? { variables } : {}) });
        return res.data.map((a) => ({
            selector: a.selector,
            description: a.description,
            ...(a.method !== undefined ? { method: a.method } : {}),
            ...(a.arguments !== undefined ? { arguments: a.arguments } : {}),
        }));
    }
    async extract(instruction, schema, opts = {}) {
        // Stagehand's zod copy (4.4.x) serialises our zod-4 schema via z.toJSONSchema and parses the reply
        // with schema.parse; the two zod builds interoperate at runtime but not at the type level.
        const extract = this.d.stagehand.extract.bind(this.d.stagehand);
        const res = await extract(instruction, schema, { timeout: Math.max(opts.timeoutMs ?? this.actionTimeout, LLM_STEP_TIMEOUT_MS) });
        return res.data;
    }
    observe(instruction) {
        return this.observeRaw(instruction, undefined, LLM_STEP_TIMEOUT_MS);
    }
    async fetch(url, init = {}) {
        return this.page.evaluate(pageFetchJs(url, init));
    }
    async exists(selector) {
        try {
            return (await this.page.locator(selector).count()) > 0;
        }
        catch {
            return false;
        }
    }
    async click(selector) {
        await this.page.locator(selector).first().click();
    }
    async fill(selector, value) {
        const ok = await this.page.evaluate(fillJs(selector, value));
        if (!ok)
            await this.page.locator(selector).first().fill(value);
    }
    async upload(selector, filePath) {
        await this.page.locator(selector).first().setInputFiles(filePath);
    }
    async waitForText(text, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        const js = `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`;
        for (;;) {
            try {
                if (await this.page.evaluate(js))
                    return true;
            }
            catch {
                // navigating; retry until the deadline
            }
            if (Date.now() >= deadline)
                return false;
            await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
        }
    }
    async waitForSelector(selector, timeoutMs) {
        try {
            return await this.page.waitForSelector(selector, { state: "attached", timeout: timeoutMs });
        }
        catch {
            return false;
        }
    }
    evaluate(js) {
        return this.page.evaluate(js);
    }
    /** An eased curve (one random control point off the straight line), 12-40 trusted mouseMoved events. */
    async moveMouse(to) {
        const from = this.mouse;
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const bend = { x: (from.x + to.x) / 2 + rnd(-0.25, 0.25) * dist, y: (from.y + to.y) / 2 + rnd(-0.25, 0.25) * dist };
        const steps = Math.max(12, Math.min(40, Math.round(dist / 25)));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
            const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * bend.x + e * e * to.x;
            const y = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * bend.y + e * e * to.y;
            await this.page.hover(Math.round(x), Math.round(y));
            await sleep(rnd(6, 20));
        }
        this.mouse = to;
    }
    box(selector) {
        return this.page.evaluate(boxJs(selector)).catch(() => null);
    }
    async humanize(targets, ms) {
        const end = Date.now() + ms;
        const at = () => ({ x: Math.round(this.mouse.x), y: Math.round(this.mouse.y) });
        try {
            await this.page.hover(at().x, at().y);
            for (let i = 0, n = 2 + Math.floor(rnd(0, 3)); i < n; i++) {
                await this.page.scroll(at().x, at().y, 0, Math.round(rnd(200, 600)));
                await sleep(rnd(400, 1200));
            }
            for (let i = 0, n = 1 + Math.floor(rnd(0, 2)); i < n; i++) {
                await this.page.scroll(at().x, at().y, 0, -Math.round(rnd(200, 500)));
                await sleep(rnd(300, 900));
            }
            for (const sel of targets) {
                const b = await this.box(sel);
                if (!b)
                    continue;
                await this.moveMouse({ x: b.x + rnd(-0.3, 0.3) * b.w, y: b.y + rnd(-0.3, 0.3) * b.h });
                await sleep(rnd(300, 900));
            }
            // Idle near the last target (the submit button) until the time is up, with small drifts.
            while (Date.now() < end) {
                await sleep(Math.min(Math.max(0, end - Date.now()), rnd(1500, 4000)));
                if (Date.now() < end)
                    await this.moveMouse({ x: this.mouse.x + rnd(-20, 20), y: this.mouse.y + rnd(-12, 12) });
            }
        }
        catch {
            // presence is best effort: a failed mouse event must not fail the apply
            const left = end - Date.now();
            if (left > 0)
                await sleep(left);
        }
    }
    async retype(selector) {
        const before = await this.page.evaluate(valueJs(selector)).catch(() => null);
        if (!before)
            return false;
        try {
            const b = await this.box(selector);
            if (b) {
                await this.moveMouse({ x: b.x + rnd(-0.3, 0.3) * b.w, y: b.y + rnd(-0.25, 0.25) * b.h });
                await sleep(rnd(150, 450));
                // A covered field (open modal) would lose the click to the overlay: focus comes from selectValueJs instead.
                if (!b.covered)
                    await this.page.click(Math.round(this.mouse.x), Math.round(this.mouse.y));
            }
            if ((await this.page.evaluate(selectValueJs(selector))) === null)
                return false;
            await sleep(rnd(200, 600));
            await this.page.keyPress("Backspace");
            // Word by word with a fresh per-key delay, the odd corrected typo, a pause between words; Enter for newlines.
            const lines = before.replace(/\r\n/g, "\n").split("\n");
            for (let li = 0; li < lines.length; li++) {
                if (li > 0)
                    await this.page.keyPress("Enter");
                for (const word of lines[li].match(/\S+\s*|\s+/g) ?? []) {
                    await this.page.type(word, { delay: Math.round(rnd(55, 150)), withMistakes: Math.random() < 0.08 });
                    if (Math.random() < 0.15)
                        await sleep(rnd(250, 900));
                }
            }
            await sleep(rnd(200, 500));
            const after = await this.page.evaluate(valueJs(selector));
            if (after !== null && norm(after) === norm(before))
                return true;
        }
        catch {
            // fall through to the restore below
        }
        await this.fill(selector, before).catch(() => undefined);
        return false;
    }
    async pressEscape() {
        await this.page.keyPress("Escape");
    }
    async pressKey(key) {
        await this.page.keyPress(key);
    }
    async snapshot(name) {
        const dir = this.d.opts.snapshotDir;
        mkdirSync(dir, { recursive: true });
        const base = join(dir, name.replace(/[^a-z0-9._-]/gi, "_"));
        const [html, url] = await Promise.all([this.html().catch(() => ""), this.url().catch(() => "")]);
        writeFileSync(`${base}.html`, html);
        writeFileSync(`${base}.url`, url);
        try {
            writeFileSync(`${base}.png`, await this.page.screenshot({ type: "png" }));
        }
        catch {
            // a screenshot failure must not hide the html snapshot
        }
        return `${base}.html`;
    }
    async cookies() {
        const all = await this.d.browser.context.cookies();
        return all.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
        }));
    }
    async setCookies(cookies) {
        if (cookies.length === 0)
            return;
        await this.d.browser.context.addCookies(cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || "/",
            httpOnly: c.httpOnly,
            secure: c.secure,
            ...(c.sameSite ? { sameSite: c.sameSite } : {}),
            ...(c.expires > 0 ? { expires: c.expires } : {}),
        })));
    }
    memoryMB() {
        return chromiumTreeRssMB(this.d.opts.userDataDir);
    }
    close() {
        this.closing ??= (async () => {
            // Bounded: a wedged Chrome never answers close over CDP; the SIGKILL below still frees it.
            try {
                await Promise.race([this.d.stagehand.close(), sleep(10_000)]);
            }
            catch {
                // the browser may already be gone
            }
            try {
                await Promise.race([this.d.browser.close(), sleep(10_000)]);
            }
            catch {
                // idem
            }
            await killChromiumLeftovers(this.d.opts.userDataDir);
            for (const fn of this.d.cleanup) {
                try {
                    await fn();
                }
                catch {
                    // best effort
                }
            }
        })();
        return this.closing;
    }
}
//# sourceMappingURL=session.js.map