import { type Server } from "node:http";
import { type Webtap } from "./runtime/webtap.js";
export interface ServerOptions {
    /** When set, every request needs `Authorization: Bearer <token>`. */
    token?: string;
    /** Opens session keys for PUT /sessions/:site. Unset: that route does not exist. */
    sessionSecret?: string;
    /** Request body cap. Default 1 MB. */
    maxBodyBytes?: number;
}
export declare function createServer(webtap: Webtap, opts?: ServerOptions): Server;
