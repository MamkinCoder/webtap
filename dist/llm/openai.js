import { outputFormatBlock, withStructured } from "./json.js";
import { Semaphore } from "./mutex.js";
export function openaiCompatible(opts) {
    const gate = new Semaphore(opts.concurrency ?? 4);
    const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    return {
        async generate(p) {
            const wantsJson = p.responseFormat?.type === "json_schema";
            const messages = [
                ...(p.systemPrompt?.trim() ? [{ role: "system", content: p.systemPrompt.trim() }] : []),
                ...p.messages.map((m) => ({ role: m.role, content: m.content })),
            ];
            if (p.responseFormat?.type === "json_schema")
                messages.push({ role: "user", content: outputFormatBlock(p.responseFormat.schema) });
            const body = {
                model: opts.model,
                messages,
                ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
                ...(wantsJson && opts.jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
            };
            const res = await gate.run(() => fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
            }));
            const raw = await res.text();
            if (!res.ok)
                throw new Error(`LLM HTTP ${res.status}: ${raw.slice(0, 300)}`);
            const data = JSON.parse(raw);
            return withStructured(wantsJson, { text: data.choices?.[0]?.message?.content ?? "" });
        },
    };
}
//# sourceMappingURL=openai.js.map