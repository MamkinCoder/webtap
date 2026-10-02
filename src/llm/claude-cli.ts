// WebtapLLM over the Claude Code CLI: one headless `claude -p` process per call, no API key. Good for development
// and small hosts; for production volume use openaiCompatible() or your own provider.
import { spawn } from "node:child_process";
import type { WebtapLLM } from "../types.js";
import { flattenMessages, withStructured } from "./json.js";
import { Semaphore } from "./mutex.js";

export interface ClaudeCliOptions {
  /** Default "claude". */
  bin?: string;
  /** Default "haiku": picking an element is classification. */
  model?: string;
  /** Concurrent processes. Default 1. */
  concurrency?: number;
  /** Default 120000. */
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

const STDERR_TAIL = 2000;

interface ClaudeFeatures {
  jsonSchema: boolean;
  maxTurns: boolean;
  noSessionPersistence: boolean;
  tools: boolean;
}

const NO_FEATURES: ClaudeFeatures = { jsonSchema: false, maxTurns: false, noSessionPersistence: false, tools: false };
const featureCache = new Map<string, Promise<ClaudeFeatures>>();

/** Runs `claude --help` once per binary; a failure means "no optional flags". */
function detectFeatures(bin: string, env?: Record<string, string>): Promise<ClaudeFeatures> {
  let p = featureCache.get(bin);
  if (!p) {
    p = spawnCollect(bin, { cwd: process.cwd(), timeoutMs: 15_000, env, args: ["--help"] })
      .then((r) => {
        const help = r.stdout + r.stderr;
        return {
          jsonSchema: help.includes("--json-schema"),
          maxTurns: help.includes("--max-turns"),
          noSessionPersistence: help.includes("--no-session-persistence"),
          tools: /--tools\b/.test(help),
        };
      })
      .catch(() => NO_FEATURES);
    featureCache.set(bin, p);
  }
  return p;
}

export function buildArgs(model: string, f: ClaudeFeatures, schema?: unknown): string[] {
  const args = ["-p", "--output-format", "json", "--model", model];
  if (f.maxTurns) args.push("--max-turns", "1");
  if (f.noSessionPersistence) args.push("--no-session-persistence");
  if (f.tools) args.push("--tools", "");
  if (f.jsonSchema && schema !== undefined) {
    // Some claude builds validate with a draft-07 validator that rejects the draft/2020-12 "$schema" tag
    // (zod and Stagehand both add it); the schema bodies are draft-07 compatible.
    const { $schema: _drop, ...body } = (schema ?? {}) as Record<string, unknown>;
    args.push("--json-schema", JSON.stringify(body));
  }
  return args;
}

/** `--output-format json` prints one result object (older builds: an array ending with it). */
export function parseEnvelope(stdout: string): { text: string; structured?: unknown; isError: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { text: stdout, isError: false };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const result = [...list].reverse().find((m) => isRecord(m) && m.type === "result") ?? list[list.length - 1];
  if (!isRecord(result)) return { text: stdout, isError: false };
  const text = typeof result.result === "string" ? result.result : "";
  return {
    text,
    structured: result.structured_output,
    isError: result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error")),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function claudeCli(opts: ClaudeCliOptions = {}): WebtapLLM {
  const bin = opts.bin ?? "claude";
  const model = opts.model ?? "haiku";
  const gate = new Semaphore(opts.concurrency ?? 1);
  return {
    async generate(p) {
      const wantsJson = p.responseFormat?.type === "json_schema";
      const schema = p.responseFormat?.type === "json_schema" ? p.responseFormat.schema : undefined;
      const features = await detectFeatures(bin, opts.env);
      const r = await gate.run(() =>
        spawnCollect(bin, {
          args: buildArgs(model, features, schema),
          cwd: opts.cwd ?? process.cwd(),
          stdin: flattenMessages(p),
          timeoutMs: opts.timeoutMs ?? 120_000,
          env: opts.env,
        }),
      );
      const tail = r.stderr.slice(-STDERR_TAIL).trim();
      if (r.timedOut) throw new Error(`claude timed out after ${r.durationMs} ms`);
      if (r.exitCode !== 0) throw new Error(`claude exited with code ${r.exitCode}: ${tail || r.stdout.slice(-300)}`);
      const env = parseEnvelope(r.stdout);
      if (env.isError) throw new Error(`claude reported an error: ${env.text.slice(0, 300)}`);
      return withStructured(wantsJson, env);
    },
  };
}

interface SpawnOpts {
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  env?: Record<string, string> | undefined;
}

function spawnCollect(bin: string, o: SpawnOpts): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, o.args, {
      cwd: o.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...o.env },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2000).unref();
    }, o.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cannot start ${bin}: ${err.message}`));
    });
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: Date.now() - started, timedOut });
    };
    child.on("close", settle);
    // A killed child may leave grandchildren holding the pipes; don't wait for them.
    child.on("exit", (code) => {
      if (timedOut) setImmediate(() => settle(code));
    });
    child.stdin.on("error", () => undefined); // EPIPE when the child dies early
    child.stdin.end(o.stdin ?? "");
  });
}
