// Maps Stagehand's client-LLM callback (`model: { generate }`, see ClientLLMSchema in
// @browserbasehq/stagehand dist/index.d.mts) onto our text-only WebtapLLM contract and back.
// Pure: no I/O.
import type { ClientLLM } from "@browserbasehq/stagehand";
import type { WebtapLLM } from "../types.js";

type StagehandGenerate = ClientLLM["generate"];
type GenerateParams = Parameters<StagehandGenerate>[0];
type GenerateResult = Awaited<ReturnType<StagehandGenerate>>;
type LLMParams = Parameters<WebtapLLM["generate"]>[0];
type LLMResponse = Awaited<ReturnType<WebtapLLM["generate"]>>;

type ContentPart = GenerateParams["messages"][number]["content"];

/** Flattens Stagehand's content parts (text / image / tool_use / tool_result) into plain text. */
function partsToText(content: ContentPart): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((p) => {
      switch (p.type) {
        case "text":
          return p.text;
        case "image":
          return `[image ${p.mimeType}]`;
        case "tool_use":
          return `[tool_use ${p.name}] ${JSON.stringify(p.input)}`;
        case "tool_result":
          return p.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n");
        default:
          return "";
      }
    })
    .join("\n");
}

function toLLMParams(params: GenerateParams): LLMParams {
  const rf = params.responseFormat;
  return {
    messages: params.messages.map((m) => ({ role: m.role, content: partsToText(m.content) })),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    responseFormat: rf && rf.type === "json_schema" ? { type: "json_schema", schema: rf.schema } : { type: "text" },
  };
}

/** Accepts raw JSON or a ```json fenced block; throws on anything else. */
function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error(`LLM returned non-JSON for a json_schema request: ${trimmed.slice(0, 200)}`);
  }
}

function toStagehandResult(params: GenerateParams, res: LLMResponse): GenerateResult {
  const text = res.text ?? "";
  if (params.responseFormat?.type === "json_schema") {
    const structured = res.structured !== undefined ? res.structured : parseStructured(text);
    return {
      role: "assistant",
      content: { type: "text", text: text || JSON.stringify(structured) },
      outputFormat: "json_schema",
      structuredContent: structured as GenerateResult extends { structuredContent: infer S } ? S : never,
    } as GenerateResult;
  }
  return { role: "assistant", content: { type: "text", text }, outputFormat: "text" };
}

export function adaptLLM(llm: WebtapLLM): StagehandGenerate {
  return async (params) => toStagehandResult(params, await llm.generate(toLLMParams(params)));
}
