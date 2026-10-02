// Best-effort JSON extraction from model text: whole text, a fenced block, then the first balanced {...} or [...]
// that parses. Throws when nothing parses.
export function extractJson(text: string): unknown {
  const t = text.trim();
  const whole = tryParse(t);
  if (whole !== NOPE) return whole;
  for (const m of t.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
    const v = tryParse((m[1] ?? "").trim());
    if (v !== NOPE) return v;
  }
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== "{" && c !== "[") continue;
    const end = balancedEnd(t, i);
    if (end < 0) continue;
    const v = tryParse(t.slice(i, end + 1));
    if (v !== NOPE) return v;
  }
  throw new Error(`no JSON found in model output: ${t.slice(0, 120)}`);
}

const NOPE = Symbol("no-json");
function tryParse(s: string): unknown {
  if (!s || (s[0] !== "{" && s[0] !== "[")) return NOPE;
  try {
    return JSON.parse(s);
  } catch {
    return NOPE;
  }
}

function balancedEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export const outputFormatBlock = (schema: unknown): string =>
  `### OUTPUT FORMAT\nReturn only JSON matching this schema, no prose, no code fences:\n${JSON.stringify(schema)}`;

/** One prompt from a chat (`### SYSTEM / ### USER / ### OUTPUT FORMAT`), for providers that take a single text. */
export function flattenMessages(p: {
  messages: { role: string; content: string }[];
  systemPrompt?: string;
  responseFormat?: { type: "json_schema"; schema: unknown } | { type: "text" };
}): string {
  const blocks: string[] = ["Continue the conversation below as the assistant. Output only the assistant reply, nothing else."];
  if (p.systemPrompt?.trim()) blocks.push(`### SYSTEM\n${p.systemPrompt.trim()}`);
  for (const m of p.messages) blocks.push(`### ${m.role.toUpperCase()}\n${m.content.trim()}`);
  if (p.responseFormat?.type === "json_schema") blocks.push(outputFormatBlock(p.responseFormat.schema));
  return `${blocks.join("\n\n")}\n`;
}

/** Fills `structured` from the text when the provider did not, for json_schema requests. */
export function withStructured(wantsJson: boolean, r: { text: string; structured?: unknown }): { text: string; structured?: unknown } {
  if (!wantsJson) return { text: r.text };
  let structured = r.structured;
  if (structured === undefined) {
    try {
      structured = extractJson(r.text);
    } catch {
      // no JSON in the text: structured stays undefined and the Stagehand adapter reports it
    }
  }
  const text = structured !== undefined && !r.text.trim() ? JSON.stringify(structured) : r.text;
  return { text, structured };
}
