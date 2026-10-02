// WebtapLLM over the Claude Code CLI: one headless `claude -p` process per call, no API key. Good for development
// and small hosts; for production volume use openaiCompatible() or your own provider.
import { spawn } from "node:child_process";
import { flattenMessages, withStructured } from "./json.js";
import { Semaphore } from "./mutex.js";
const STDERR_TAIL = 2000;
const NO_FEATURES = { jsonSchema: false, maxTurns: false, noSessionPersistence: false, tools: false };
const featureCache = new Map();
/** Runs `claude --help` once per binary; a failure means "no optional flags". */
function detectFeatures(bin, env) {
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
export function buildArgs(model, f, schema) {
    const args = ["-p", "--output-format", "json", "--model", model];
    if (f.maxTurns)
        args.push("--max-turns", "1");
    if (f.noSessionPersistence)
        args.push("--no-session-persistence");
    if (f.tools)
        args.push("--tools", "");
    if (f.jsonSchema && schema !== undefined) {
        // Some claude builds validate with a draft-07 validator that rejects the draft/2020-12 "$schema" tag
        // (zod and Stagehand both add it); the schema bodies are draft-07 compatible.
        const { $schema: _drop, ...body } = (schema ?? {});
        args.push("--json-schema", JSON.stringify(body));
    }
    return args;
}
/** `--output-format json` prints one result object (older builds: an array ending with it). */
export function parseEnvelope(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout.trim());
    }
    catch {
        return { text: stdout, isError: false };
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const result = [...list].reverse().find((m) => isRecord(m) && m.type === "result") ?? list[list.length - 1];
    if (!isRecord(result))
        return { text: stdout, isError: false };
    const text = typeof result.result === "string" ? result.result : "";
    return {
        text,
        structured: result.structured_output,
        isError: result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error")),
    };
}
const isRecord = (v) => typeof v === "object" && v !== null;
export function claudeCli(opts = {}) {
    const bin = opts.bin ?? "claude";
    const model = opts.model ?? "haiku";
    const gate = new Semaphore(opts.concurrency ?? 1);
    return {
        async generate(p) {
            const wantsJson = p.responseFormat?.type === "json_schema";
            const schema = p.responseFormat?.type === "json_schema" ? p.responseFormat.schema : undefined;
            const features = await detectFeatures(bin, opts.env);
            const r = await gate.run(() => spawnCollect(bin, {
                args: buildArgs(model, features, schema),
                cwd: opts.cwd ?? process.cwd(),
                stdin: flattenMessages(p),
                timeoutMs: opts.timeoutMs ?? 120_000,
                env: opts.env,
            }));
            const tail = r.stderr.slice(-STDERR_TAIL).trim();
            if (r.timedOut)
                throw new Error(`claude timed out after ${r.durationMs} ms`);
            if (r.exitCode !== 0)
                throw new Error(`claude exited with code ${r.exitCode}: ${tail || r.stdout.slice(-300)}`);
            const env = parseEnvelope(r.stdout);
            if (env.isError)
                throw new Error(`claude reported an error: ${env.text.slice(0, 300)}`);
            return withStructured(wantsJson, env);
        },
    };
}
function spawnCollect(bin, o) {
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
                if (!settled)
                    child.kill("SIGKILL");
            }, 2000).unref();
        }, o.timeoutMs);
        child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
        child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`cannot start ${bin}: ${err.message}`));
        });
        const settle = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: Date.now() - started, timedOut });
        };
        child.on("close", settle);
        // A killed child may leave grandchildren holding the pipes; don't wait for them.
        child.on("exit", (code) => {
            if (timedOut)
                setImmediate(() => settle(code));
        });
        child.stdin.on("error", () => undefined); // EPIPE when the child dies early
        child.stdin.end(o.stdin ?? "");
    });
}
//# sourceMappingURL=claude-cli.js.map