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

class RawCdp {
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
