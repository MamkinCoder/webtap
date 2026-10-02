// The explorer: an LLM operates the site one step at a time (through act(), so every element it finds is cached)
// until the page shows the results the goal asks for. Its steps become the browser fallback of the generated recipe.
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { errMessage } from "../types.js";
const Decision = z.object({
    thought: z.string(),
    action: z.discriminatedUnion("type", [
        z.object({ type: z.literal("act"), instruction: z.string() }),
        z.object({ type: z.literal("goto"), url: z.string() }),
        z.object({ type: z.literal("wait") }),
        z.object({ type: z.literal("done"), summary: z.string() }),
        z.object({ type: z.literal("blocked"), reason: z.string() }),
    ]),
});
const SYSTEM = `You operate a web browser to reach a goal on one website, so its traffic can be recorded and turned into an API.
Each turn you see the current url, the page's visible text and your previous steps, and answer with JSON:
{ "thought": "...", "action": <one of>
  { "type": "act", "instruction": "<ONE atomic action, e.g. type %city% into the destination field / click the Find button / pick the first suggestion>" }
  { "type": "goto", "url": "<absolute url on this site; %name% placeholders allowed>" }
  { "type": "wait" }   (results are still loading)
  { "type": "done", "summary": "<what the page now shows>" }
  { "type": "blocked", "reason": "<captcha / anti-bot wall / login required>" } }
Rules:
- Use the sample inputs through their %name% placeholders in instructions (they are filled in for you), never the literal values.
- One action per turn. Close cookie banners or popups only if they block you.
- Prefer the site's own search form. But if a form control (date picker, dropdown) fails twice, stop fighting it: go to
  the results page directly with the inputs in the url (query parameters or path), using the site's own link patterns
  you can see in "Links on the page", e.g. "goto https://site/hotels/%city%/?checkin=%checkIn%".
- Say done only when the page lists the results the goal asks for. Do not open individual results.
- A captcha, "are you a robot" check or access wall is NOT done: answer blocked.`;
// Distinct same-site link targets, so the explorer can see the site's url patterns.
const LINKS_JS = `(function(){
  var seen = {}, out = [];
  document.querySelectorAll("a[href]").forEach(function(a){
    try { var u = new URL(a.href, location.href); } catch (e) { return; }
    if (u.host !== location.host) return;
    var k = u.pathname + u.search;
    if (seen[k] || out.length >= 40) return;
    seen[k] = 1; out.push(k.slice(0, 160));
  });
  return out;
})()`;
/** %name% → value (URI-encoded inside urls). */
export function fillPlaceholders(s, vars, uri) {
    return s.replace(/%([A-Za-z_$][\w$]*)%/g, (m, k) => (k in vars ? (uri ? encodeURIComponent(vars[k]) : vars[k]) : m));
}
export async function explore(s, llm, o) {
    const steps = [];
    const variables = Object.fromEntries(Object.entries(o.inputs).map(([k, v]) => [k, String(v)]));
    const placeholders = Object.entries(o.inputs)
        .map(([k, v]) => `%${k}% = ${JSON.stringify(v)}`)
        .join(", ");
    const log = o.log ?? (() => undefined);
    for (let n = 0; n < (o.maxSteps ?? 20); n++) {
        const [url, text, links] = await Promise.all([s.url().catch(() => ""), s.text(6_000).catch(() => ""), s.evaluate(LINKS_JS).catch(() => [])]);
        const history = steps.length
            ? steps.map((st, i) => `${i + 1}. ${st.kind} ${st.value} → ${st.ok ? "ok" : "FAILED"} ${st.message.slice(0, 120)}`).join("\n")
            : "(none yet)";
        const res = await llm.generate({
            systemPrompt: SYSTEM,
            messages: [
                {
                    role: "user",
                    content: `Goal: ${o.goal}\nSample inputs: ${placeholders}\nCurrent url: ${url}\nPrevious steps:\n${history}\n\nLinks on the page (same site, sample):\n${links.join("\n")}\n\nVisible page text (truncated):\n${text}`,
                },
            ],
            responseFormat: { type: "json_schema", schema: z.toJSONSchema(Decision) },
            temperature: 0,
        });
        const parsed = Decision.safeParse(res.structured);
        if (!parsed.success) {
            log(`  step ${n + 1}: unreadable decision, retrying`);
            continue;
        }
        const a = parsed.data.action;
        log(`  step ${n + 1}: ${a.type}${"instruction" in a ? ` "${a.instruction}"` : "url" in a ? ` ${a.url}` : ""} (${parsed.data.thought.slice(0, 100)})`);
        if (a.type === "done")
            return { steps, done: true, summary: a.summary };
        if (a.type === "blocked")
            return { steps, done: false, blocked: a.reason, summary: `blocked: ${a.reason}` };
        if (a.type === "wait") {
            await sleep(2_500);
            continue;
        }
        if (a.type === "goto") {
            try {
                await s.goto(fillPlaceholders(a.url, variables, true));
                steps.push({ kind: "goto", value: a.url, ok: true, message: "" });
            }
            catch (err) {
                steps.push({ kind: "goto", value: a.url, ok: false, message: errMessage(err) });
            }
            continue;
        }
        try {
            const r = await s.act(a.instruction, { cacheKey: `explore.${steps.length + 1}`, variables });
            steps.push({ kind: "act", value: a.instruction, ok: r.success, message: r.message });
        }
        catch (err) {
            steps.push({ kind: "act", value: a.instruction, ok: false, message: errMessage(err) });
        }
        await sleep(2_000); // let the page react and its requests finish
    }
    return { steps, done: false, summary: "step limit reached" };
}
//# sourceMappingURL=explore.js.map