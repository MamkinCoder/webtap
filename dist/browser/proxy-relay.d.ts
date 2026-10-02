import type { ProxyConfig } from "../types.js";
export interface ProxyRelay {
    /** "http://127.0.0.1:<port>" — give this to Chrome. */
    server: string;
    close(): Promise<void>;
}
export declare function startProxyRelay(upstream: ProxyConfig): Promise<ProxyRelay>;
