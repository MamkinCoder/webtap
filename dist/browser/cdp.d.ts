type Listener = (params: Record<string, unknown>, sessionId?: string) => void;
export declare class RawCdp {
    private readonly ws;
    private nextId;
    private readonly pending;
    private readonly listeners;
    closed: boolean;
    private constructor();
    static connect(wsUrl: string): Promise<RawCdp>;
    send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
    on(method: string, listener: Listener): void;
    close(): void;
    private dispose;
    private onMessage;
}
/**
 * Attaches (flat sessions) to every current and future page target and installs the block list.
 * Returns a disposer. Failures are swallowed: blocking is an optimisation, never a hard dependency.
 */
export declare function installUrlBlocker(wsUrl: string, opts?: {
    assets?: boolean;
    images?: boolean;
    extra?: string[];
}): Promise<() => void>;
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
/**
 * Records requests and response bodies of every page target (documents, XHR, fetch, worker-initiated "Other").
 * Used by the mapper to find the request that carries the data a page shows. Returns a live list and a stop function.
 */
export declare function installRecorder(wsUrl: string, opts?: {
    max?: number;
}): Promise<{
    exchanges: RecordedExchange[];
    stop: () => void;
}>;
export {};
