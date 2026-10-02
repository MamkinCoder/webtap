// Tiny raw-CDP client on Node's global WebSocket. Stagehand v4 exposes no request-interception
// API and its own CDPClient ignores non-binding events, so asset blocking opens a second
// connection to the browser endpoint (Chrome allows multiple clients) and uses
// Network.setBlockedURLs on every page target — no event round-trips, cheap on small machines.

type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (ev: { data?: unknown }) => void): void;
}

const openSocket = (url: string): Promise<WsLike> =>
  new Promise((resolve, reject) => {
    const Ctor = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
    if (!Ctor) return reject(new Error("global WebSocket is unavailable (Node >= 22 required)"));
    const ws = new Ctor(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`CDP websocket failed: ${url}`)));
  });

export class RawCdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Set<Listener>>();
  closed = false;

  private constructor(private readonly ws: WsLike) {
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => this.dispose(new Error("CDP connection closed")));
    ws.addEventListener("error", () => this.dispose(new Error("CDP connection error")));
  }

  static async connect(wsUrl: string): Promise<RawCdp> {
    return new RawCdp(await openSocket(wsUrl));
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(method: string, listener: Listener): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
  }

  close(): void {
    this.dispose(new Error("CDP connection closed"));
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private dispose(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onMessage(text: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const l of this.listeners.get(msg.method) ?? []) l(msg.params ?? {}, msg.sessionId);
  }
}

const withQuery = (exts: string[]): string[] => exts.flatMap((e) => [`*.${e}`, `*.${e}?*`]);

const IMAGE_PATTERNS: readonly string[] = withQuery(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const ASSET_BLOCK_PATTERNS: readonly string[] = [
  ...withQuery(["woff", "woff2", "ttf", "otf", "eot"]),
  ...withQuery(["mp4", "webm", "mp3", "ogg", "m4a", "wav"]),
  "*mc.yandex.ru*",
  "*google-analytics.com*",
  "*googletagmanager.com*",
  "*doubleclick.net*",
  "*top-fwz1.mail.ru*",
];

/**
 * Attaches (flat sessions) to every current and future page target and installs the block list.
 * Returns a disposer. Failures are swallowed: blocking is an optimisation, never a hard dependency.
 */
export async function installUrlBlocker(
  wsUrl: string,
  opts: { assets?: boolean; images?: boolean; extra?: string[] } = {},
): Promise<() => void> {
  const urls = [
    ...(opts.assets ? ASSET_BLOCK_PATTERNS : []),
    ...(opts.assets && !opts.images ? IMAGE_PATTERNS : []),
    ...(opts.extra ?? []),
  ];
  const cdp = await RawCdp.connect(wsUrl);
  const attached = new Set<string>();
  const arm = async (sessionId: string, targetId: string): Promise<void> => {
    if (attached.has(targetId)) return;
    attached.add(targetId);
    try {
      await cdp.send("Network.enable", {}, sessionId);
      await cdp.send("Network.setBlockedURLs", { urls }, sessionId);
    } catch {
      attached.delete(targetId);
    }
  };
  cdp.on("Target.attachedToTarget", (params) => {
    const info = params.targetInfo as { type?: string; targetId?: string } | undefined;
    if (info?.type === "page" && typeof params.sessionId === "string" && info.targetId) void arm(params.sessionId, info.targetId);
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type !== "page" || attached.has(t.targetId)) continue;
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      await arm(sessionId, t.targetId);
    } catch {
      // auto-attach may already have claimed it
    }
  }
  return () => cdp.close();
}

export interface RecordedExchange {
  url: string;
  method: string;
  /** "Document" | "XHR" | "Fetch" | "Other" … (CDP resource type). */
  type: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  status: number;
  mimeType: string;
  body: string;
  /** ms timestamps (this machine's clock): request sent, response fully loaded. */
  startedAt: number;
  finishedAt: number;
}

const RECORD_TYPES = new Set(["Document", "XHR", "Fetch", "Other"]);
const MAX_RECORDED_BODY = 3_000_000;

/**
 * Records requests and response bodies of every page target (documents, XHR, fetch, worker-initiated "Other").
 * Used by the mapper to find the request that carries the data a page shows. Returns a live list and a stop function.
 */
export async function installRecorder(wsUrl: string, opts: { max?: number } = {}): Promise<{ exchanges: RecordedExchange[]; stop: () => void }> {
  const max = opts.max ?? 400;
  const cdp = await RawCdp.connect(wsUrl);
  const exchanges: RecordedExchange[] = [];
  const pending = new Map<string, Omit<RecordedExchange, "status" | "mimeType" | "body" | "finishedAt"> & { status?: number; mimeType?: string }>();
  const attached = new Set<string>();
  const key = (sessionId: string | undefined, requestId: unknown) => `${sessionId ?? ""}:${String(requestId)}`;

  cdp.on("Network.requestWillBeSent", (p, sessionId) => {
    const type = String(p.type ?? "Other");
    if (!RECORD_TYPES.has(type)) return;
    const req = p.request as { url: string; method: string; headers: Record<string, string>; postData?: string };
    if (!/^https?:/.test(req.url)) return;
    pending.set(key(sessionId, p.requestId), {
      url: req.url,
      method: req.method,
      type,
      requestHeaders: req.headers ?? {},
      ...(req.postData !== undefined ? { postData: req.postData } : {}),
      startedAt: Date.now(),
    });
  });
  cdp.on("Network.requestWillBeSentExtraInfo", (p, sessionId) => {
    // The real headers on the wire (incl. ones the page set that requestWillBeSent may not show).
    const e = pending.get(key(sessionId, p.requestId));
    if (e && p.headers) e.requestHeaders = { ...e.requestHeaders, ...(p.headers as Record<string, string>) };
  });
  cdp.on("Network.responseReceived", (p, sessionId) => {
    const e = pending.get(key(sessionId, p.requestId));
    const res = p.response as { status: number; mimeType: string } | undefined;
    if (e && res) {
      e.status = res.status;
      e.mimeType = res.mimeType;
    }
  });
  cdp.on("Network.loadingFinished", (p, sessionId) => {
    const k = key(sessionId, p.requestId);
    const e = pending.get(k);
    pending.delete(k);
    if (!e || e.status === undefined || exchanges.length >= max) return;
    const finishedAt = Date.now();
    void cdp
      .send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: p.requestId }, sessionId)
      .then((r) => {
        if (r.base64Encoded || r.body.length > MAX_RECORDED_BODY) return;
        exchanges.push({ ...e, status: e.status ?? 0, mimeType: e.mimeType ?? "", body: r.body, finishedAt });
      })
      .catch(() => undefined);
  });

  const arm = async (sessionId: string, targetId: string) => {
    if (attached.has(targetId)) return;
    attached.add(targetId);
    try {
      await cdp.send("Network.enable", { maxPostDataSize: 65_536 }, sessionId);
    } catch {
      attached.delete(targetId);
    }
  };
  cdp.on("Target.attachedToTarget", (params) => {
    const info = params.targetInfo as { type?: string; targetId?: string } | undefined;
    if (info?.targetId && typeof params.sessionId === "string" && (info.type === "page" || info.type === "worker" || info.type === "service_worker")) {
      void arm(params.sessionId, info.targetId);
    }
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type !== "page" || attached.has(t.targetId)) continue;
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      await arm(sessionId, t.targetId);
    } catch {
      // auto-attach may already have claimed it
    }
  }
  return { exchanges, stop: () => cdp.close() };
}
