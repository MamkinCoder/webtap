// HTTP front for a Webtap runtime (node:http, no framework).
//   POST /sites/:site/:endpoint   body = input JSON  → 200 { data, meta } | 400 bad input | 404 | 502 { error, attempts }
//   GET  /sites                   endpoint catalog with JSON Schemas
//   GET  /health                  per endpoint / strategy / identity health
//   POST /canaries[?site=x&perStrategy=1]
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebtapError, type Webtap } from "./runtime/webtap.js";

export interface ServerOptions {
  /** When set, every request needs `Authorization: Bearer <token>`. */
  token?: string;
  /** Request body cap. Default 1 MB. */
  maxBodyBytes?: number;
}

export function createServer(webtap: Webtap, opts: ServerOptions = {}): Server {
  return createHttpServer((req, res) => {
    handle(webtap, opts, req, res).catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });
}

async function handle(webtap: Webtap, opts: ServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (opts.token && !authorized(req.headers.authorization, opts.token)) return send(res, 401, { error: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, webtap.health());
  if (req.method === "GET" && url.pathname === "/sites") return send(res, 200, webtap.describe());
  if (req.method === "POST" && url.pathname === "/canaries") {
    const site = url.searchParams.get("site");
    return send(res, 200, await webtap.runCanaries({ ...(site ? { site } : {}), perStrategy: url.searchParams.get("perStrategy") === "1" }));
  }
  if (req.method === "POST" && parts.length === 3 && parts[0] === "sites") {
    let input: unknown;
    try {
      const raw = await readBody(req, opts.maxBodyBytes ?? 1_000_000);
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      return send(res, 400, { error: `bad JSON body: ${err instanceof Error ? err.message : String(err)}` });
    }
    const strategy = url.searchParams.get("strategy");
    try {
      const r = await webtap.call(parts[1]!, parts[2]!, input, strategy ? { strategy } : {});
      return send(res, 200, { data: r.data, meta: { strategy: r.strategy, identity: r.identity, ms: r.ms, attempts: r.attempts } });
    } catch (err) {
      if (!(err instanceof WebtapError)) throw err;
      const status = err.code === "bad_input" ? 400 : err.code === "failed" ? 502 : 404;
      return send(res, status, { error: err.message, code: err.code, attempts: err.attempts, ...(err.details ? { details: err.details } : {}) });
    }
  }
  send(res, 404, { error: "not found" });
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
