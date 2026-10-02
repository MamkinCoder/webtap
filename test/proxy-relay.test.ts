// The relay in front of an authenticated proxy: CONNECT tunnels and plain http both carry the credentials.
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startProxyRelay } from "../src/browser/proxy-relay.js";

const AUTH = `Basic ${Buffer.from("user:p@ss").toString("base64")}`;
let echo: Server;
let upstream: ReturnType<typeof createHttpServer>;
let echoPort = 0;
let upstreamPort = 0;
const seen: string[] = [];

beforeAll(async () => {
  echo = createTcpServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as AddressInfo).port;
  upstream = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers["proxy-authorization"] === AUTH ? "auth" : "noauth"}`);
    res.end("via-upstream");
  });
  upstream.on("connect", (req, client) => {
    seen.push(`CONNECT ${req.url} ${req.headers["proxy-authorization"] === AUTH ? "auth" : "noauth"}`);
    if (req.headers["proxy-authorization"] !== AUTH) return client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    const [host, port] = String(req.url).split(":");
    const target = connect(Number(port), host!, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      target.pipe(client);
      client.pipe(target);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
});
afterAll(() => {
  echo.close();
  upstream.close();
});

describe("startProxyRelay", () => {
  it("tunnels CONNECT through the upstream with credentials", async () => {
    const relay = await startProxyRelay({ server: `http://127.0.0.1:${upstreamPort}`, username: "user", password: "p@ss" });
    const port = Number(new URL(relay.server).port);
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => s.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`));
        let buf = "";
        let tunneled = false;
        s.on("data", (d) => {
          buf += d.toString();
          if (!tunneled && buf.includes("\r\n\r\n")) {
            tunneled = true;
            expect(buf).toMatch(/^HTTP\/1\.1 200/);
            buf = "";
            s.write("ping");
          } else if (tunneled && buf === "ping") {
            s.end();
            resolve(buf);
          }
        });
        s.on("error", reject);
      });
      expect(reply).toBe("ping");
      expect(seen).toContain(`CONNECT 127.0.0.1:${echoPort} auth`);
    } finally {
      await relay.close();
    }
  });

  it("forwards plain http with credentials", async () => {
    const relay = await startProxyRelay({ server: `http://127.0.0.1:${upstreamPort}`, username: "user", password: "p@ss" });
    const port = Number(new URL(relay.server).port);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "http://example.test/x", method: "GET" }, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve(b));
        });
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("via-upstream");
      expect(seen).toContain("GET http://example.test/x auth");
    } finally {
      await relay.close();
    }
  });
});
