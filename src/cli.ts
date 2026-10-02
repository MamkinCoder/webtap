#!/usr/bin/env node
// webtap CLI.
//
//   webtap map <url> --goal "find hotels in a city" --input city=Сочи --input checkIn=2026-10-16 \
//     --fields "title,priceRub:number?,rating:number?,url,imageUrl?" --id yandex-travel --out sites/yandex-travel.ts
//
// LLM: WEBTAP_LLM=claude (the `claude` CLI, model WEBTAP_MODEL or sonnet; Stagehand on haiku), or OPENAI_BASE_URL +
// OPENAI_API_KEY + OPENAI_MODEL.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { claudeCli } from "./llm/claude-cli.js";
import { openaiCompatible } from "./llm/openai.js";
import { mapSite } from "./mapper/index.js";
import type { WebtapLLM } from "./types.js";

const USAGE = `usage: webtap map <url> --goal <text> --input name=value [--input …] --fields <spec>
                  [--id <site id>] [--endpoint <name>] [--out <file.ts>] [--headful] [--max-steps N]
  --fields   output item fields: "title,priceRub:number?,url,imageUrl?" (type string|number|boolean, ? = optional)
  --input    a sample value; numbers stay numbers ("lat=55.75"); names become the endpoint's inputs`;

function llms(): { main: WebtapLLM; browser: WebtapLLM } {
  const e = process.env;
  if (e.WEBTAP_LLM === "claude" || (!e.OPENAI_API_KEY && e.WEBTAP_LLM !== "openai")) {
    return { main: claudeCli({ model: e.WEBTAP_MODEL || "sonnet", timeoutMs: 240_000 }), browser: claudeCli({ model: "haiku" }) };
  }
  if (!e.OPENAI_BASE_URL || !e.OPENAI_API_KEY || !e.OPENAI_MODEL) throw new Error("set WEBTAP_LLM=claude, or OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL");
  const llm = openaiCompatible({ baseUrl: e.OPENAI_BASE_URL, apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL });
  return { main: llm, browser: llm };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "map") {
    console.error(USAGE);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      goal: { type: "string" },
      input: { type: "string", multiple: true },
      fields: { type: "string" },
      id: { type: "string" },
      endpoint: { type: "string" },
      out: { type: "string" },
      headful: { type: "boolean" },
      "max-steps": { type: "string" },
    },
  });
  const url = positionals[0];
  if (!url || !values.goal || !values.fields) {
    console.error(USAGE);
    return 2;
  }
  const inputs: Record<string, string | number> = {};
  for (const kv of values.input ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new Error(`--input expects name=value, got "${kv}"`);
    const v = kv.slice(eq + 1);
    inputs[kv.slice(0, eq)] = v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) ? Number(v) : v;
  }
  const { main: llm, browser } = llms();
  const t0 = Date.now();
  const { source, report } = await mapSite({
    url,
    goal: values.goal,
    inputs,
    fields: values.fields,
    llm,
    browserLlm: browser,
    headless: !values.headful,
    ...(values.id ? { id: values.id } : {}),
    ...(values.endpoint ? { endpoint: values.endpoint } : {}),
    ...(values["max-steps"] ? { maxSteps: Number(values["max-steps"]) } : {}),
    log: (m) => console.error(m),
  });
  if (values.out) await writeFile(values.out, source);
  else process.stdout.write(source);
  console.error(`\n${JSON.stringify(report, null, 2)}`);
  console.error(`\ndone in ${Math.round((Date.now() - t0) / 1000)} s${values.out ? `: ${values.out}` : ""}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
