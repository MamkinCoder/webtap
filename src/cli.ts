#!/usr/bin/env node
// webtap CLI.
//
//   webtap map <url> --goal "find hotels in a city" --input city=Сочи --input checkIn=2026-10-16 \
//     --fields "title,priceRub:number?,rating:number?,url,imageUrl?" --id yandex-travel --out sites/yandex-travel.ts
//
//   webtap login <sites-file> --site avito [--identity id] [--data-dir .webtap] [--out avito.key]
//       opens the site in a visible browser; sign in, press Enter: prints a session key (sealed with WEBTAP_SESSION_SECRET)
//   webtap session import <sites-file> --site avito [--key-file avito.key | WEBTAP_SESSION_KEY]
//       signs the site in on this machine from a session key
//   webtap session info [--key-file avito.key | WEBTAP_SESSION_KEY]
//       what a key holds (site, cookie count, domains, soonest expiry), never the values
//
// LLM: WEBTAP_LLM=claude (the `claude` CLI, model WEBTAP_MODEL or sonnet; Stagehand on haiku), or OPENAI_BASE_URL +
// OPENAI_API_KEY + OPENAI_MODEL.
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createWebtap } from "./runtime/webtap.js";
import type { SiteDef } from "./runtime/site.js";
import { decodeSessionKey, describeSession, encodeSessionKey } from "./session/key.js";
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

const SESSION_USAGE = `usage: webtap login <sites-file> --site <id> [--identity <id>] [--data-dir <dir>] [--out <file>]
       webtap session import <sites-file> --site <id> [--identity <id>] [--data-dir <dir>] [--key-file <file>]
       webtap session info [--key-file <file>]
  the key is sealed with WEBTAP_SESSION_SECRET; import reads it from --key-file or WEBTAP_SESSION_KEY`;

/** The site definitions a module exports (named or default): anything with an id and endpoints. */
async function loadSites(file: string): Promise<SiteDef[]> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as Record<string, unknown>;
  const found = Object.values(mod).flatMap((v) => (v && typeof v === "object" && "default" in v ? [v, (v as { default: unknown }).default] : [v]));
  return found.filter((v): v is SiteDef => !!v && typeof v === "object" && typeof (v as SiteDef).id === "string" && "endpoints" in (v as object) && "origin" in (v as object));
}

const secretOrThrow = (): string => {
  const secret = process.env.WEBTAP_SESSION_SECRET;
  if (!secret) throw new Error("set WEBTAP_SESSION_SECRET: the key is sealed with it");
  return secret;
};

async function keyFrom(keyFile: string | undefined): Promise<string> {
  const key = keyFile ? await readFile(keyFile, "utf8") : process.env.WEBTAP_SESSION_KEY;
  if (!key?.trim()) throw new Error("no session key: pass --key-file or set WEBTAP_SESSION_KEY");
  return key.trim();
}

async function sessionCommand(cmd: string, rest: string[]): Promise<number> {
  const sub = cmd === "login" ? "login" : rest[0];
  const args = cmd === "login" ? rest : rest.slice(1);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { site: { type: "string" }, identity: { type: "string" }, "data-dir": { type: "string" }, out: { type: "string" }, "key-file": { type: "string" } },
  });
  if (sub === "info") {
    console.log(JSON.stringify(describeSession(decodeSessionKey(await keyFrom(values["key-file"]), secretOrThrow())), null, 2));
    return 0;
  }
  const [file] = positionals;
  if ((sub !== "login" && sub !== "import") || !file || !values.site) {
    console.error(SESSION_USAGE);
    return 2;
  }
  const sites = await loadSites(file);
  const site = sites.find((s) => s.id === values.site);
  if (!site) throw new Error(`no site "${values.site}" in ${file} (found: ${sites.map((s) => s.id).join(", ") || "none"})`);
  const webtap = createWebtap({ sites: [site], dataDir: values["data-dir"] ?? ".webtap", browser: { headless: false, maxSessions: 1 } });
  try {
    if (sub === "login") {
      const secret = secretOrThrow();
      const bundle = await webtap.exportSession(site.id, {
        ...(values.identity ? { identity: values.identity } : {}),
        whileOpen: async () => {
          console.error(`A browser opened on ${site.origin}. Sign in there, then come back here and press Enter (do not close it first).`);
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          await rl.question("");
          rl.close();
        },
      });
      const key = encodeSessionKey(bundle, secret);
      if (values.out) await writeFile(values.out, `${key}\n`, { mode: 0o600 });
      else process.stdout.write(`${key}\n`);
      console.error(`session for ${site.id}: ${describeSession(bundle).cookies} cookies${values.out ? ` written to ${values.out}` : ""}`);
      return 0;
    }
    const bundle = decodeSessionKey(await keyFrom(values["key-file"]), secretOrThrow());
    const { cookies } = await webtap.importSession(site.id, bundle, values.identity ? { identity: values.identity } : {});
    console.error(`imported ${cookies} cookies for ${site.id}`);
    return 0;
  } finally {
    await webtap.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "login" || cmd === "session") return sessionCommand(cmd, rest);
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
