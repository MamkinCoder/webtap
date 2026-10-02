// WebtapLLM over any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek, OpenRouter, vLLM, proxies).
// json_schema requests ask for json_object (widely supported) and carry the schema in the prompt.
import type { WebtapLLM } from "../types.js";
import { outputFormatBlock, withStructured } from "./json.js";
import { Semaphore } from "./mutex.js";

export interface OpenAICompatibleOptions {
  /** e.g. "https://api.openai.com/v1" (the "/chat/completions" path is appended). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Concurrent requests. Default 4. */
  concurrency?: number;
  /** Default 120000. */
  timeoutMs?: number;
  /** Send response_format json_object for json_schema requests. Default true; turn off for servers that reject it. */
  jsonMode?: boolean;
}

export function openaiCompatible(opts: OpenAICompatibleOptions): WebtapLLM {
  const gate = new Semaphore(opts.concurrency ?? 4);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async generate(p) {
      const wantsJson = p.responseFormat?.type === "json_schema";
      const messages = [
        ...(p.systemPrompt?.trim() ? [{ role: "system", content: p.systemPrompt.trim() }] : []),
        ...p.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      if (p.responseFormat?.type === "json_schema") messages.push({ role: "user", content: outputFormatBlock(p.responseFormat.schema) });
      const body = {
        model: opts.model,
        messages,
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(wantsJson && opts.jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
      };
      const res = await gate.run(() =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        }),
      );
      const raw = await res.text();
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${raw.slice(0, 300)}`);
      const data = JSON.parse(raw) as { choices?: { message?: { content?: string | null } }[] };
      return withStructured(wantsJson, { text: data.choices?.[0]?.message?.content ?? "" });
    },
  };
}
