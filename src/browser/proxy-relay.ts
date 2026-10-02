// A local, credential-free HTTP proxy in front of an authenticated upstream proxy. Stagehand's local browser cannot
// take proxy credentials ("Authenticated local browser proxies are not supported yet"), and every rented proxy has
// them; Chrome is pointed at this relay instead, which adds Proxy-Authorization on the way out.
//   CONNECT (https): open a tunnel through the upstream with credentials, then pipe bytes both ways.
//   plain http:      forward the absolute-URI request to the upstream with credentials.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { ProxyConfig } from "../types.js";

export interface ProxyRelay {
  /** "http://127.0.0.1:<port>" — give this to Chrome. */
  server: string;
  close(): Promise<void>;
}

export async function startProxyRelay(upstream: ProxyConfig): Promise<ProxyRelay> {
  const up = new URL(upstream.server);
  if (up.protocol !== "http:") throw new Error(`proxy relay supports http:// upstream proxies, got ${up.protocol}`);
  const upHost = up.hostname;
  const upPort = Number(up.port || 80);
  const auth = `Basic ${Buffer.from(`${upstream.username ?? ""}:${upstream.password ?? ""}`).toString("base64")}`;
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain http through the upstream: same request, absolute url, plus credentials.
    const out = httpRequest(
      { host: upHost, port: upPort, method: req.method, path: req.url, headers: { ...req.headers, "proxy-authorization": auth } },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    out.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client);
    const upstreamSocket = connect(upPort, upHost);
    track(upstreamSocket);
    const fail = () => {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstreamSocket.destroy();
    };
    upstreamSocket.once("error", fail);
    client.on("error", () => upstreamSocket.destroy());
    upstreamSocket.once("connect", () => {
      upstreamSocket.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        upstreamSocket.off("data", onData);
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString("latin1"))?.[1];
        if (status !== "200") {
          client.end(`HTTP/1.1 ${status ?? "502"} Upstream Proxy Refused\r\n\r\n`);
          upstreamSocket.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = buf.subarray(end + 4);
        if (rest.length) client.write(rest);
        if (head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(client);
        client.pipe(upstreamSocket);
      };
      upstreamSocket.on("data", onData);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
