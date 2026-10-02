/** Flattens Stagehand's content parts (text / image / tool_use / tool_result) into plain text. */
function partsToText(content) {
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
function toLLMParams(params) {
    const rf = params.responseFormat;
    return {
        messages: params.messages.map((m) => ({ role: m.role, content: partsToText(m.content) })),
        ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        responseFormat: rf && rf.type === "json_schema" ? { type: "json_schema", schema: rf.schema } : { type: "text" },
    };
}
/** Accepts raw JSON or a ```json fenced block; throws on anything else. */
function parseStructured(text) {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const body = fenced?.[1] ?? trimmed;
    try {
        return JSON.parse(body);
    }
    catch {
        const start = body.search(/[[{]/);
        const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
        if (start >= 0 && end > start)
            return JSON.parse(body.slice(start, end + 1));
        throw new Error(`LLM returned non-JSON for a json_schema request: ${trimmed.slice(0, 200)}`);
    }
}
function toStagehandResult(params, res) {
    const text = res.text ?? "";
    if (params.responseFormat?.type === "json_schema") {
        const structured = res.structured !== undefined ? res.structured : parseStructured(text);
        return {
            role: "assistant",
            content: { type: "text", text: text || JSON.stringify(structured) },
            outputFormat: "json_schema",
            structuredContent: structured,
        };
    }
    return { role: "assistant", content: { type: "text", text }, outputFormat: "text" };
}
export function adaptLLM(llm) {
    return async (params) => toStagehandResult(params, await llm.generate(toLLMParams(params)));
}
//# sourceMappingURL=adapter.js.map