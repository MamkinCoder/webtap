// Manual check (needs a Chrome-compatible binary): the clean engine in a browser it did not start. Starts the binary
// with a DevTools port, then: a session opens its own tab and loads the site (no UA override with nativePersona),
// close() leaves the browser running, the next session replaces the leftover tab, wipeRemoteBrowser() forgets the
// site's cookies and storage. Run: npm run build && CHROME=/path/to/chrome node test/remote.e2e.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createCleanLauncher } from "../dist/browser/clean.js";
import { findChrome } from "../dist/browser/launcher.js";
import { wipeRemoteBrowser } from "../dist/browser/remote.js";

const chrome = process.env.CHROME || findChrome();
const port = 9300 + Math.floor(Math.random() * 500);
const seen = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url, ua: req.headers["user-agent"], cookie: req.headers.cookie ?? "" });
  res.setHeader("Set-Cookie", "visit=1; Max-Age=3600; Path=/");
  res.end("<!doctype html><title>remote</title>ok");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}/`;
const dir = mkdtempSync(join(tmpdir(), "remote-e2e-"));
const browserProc = spawn(chrome, [`--user-data-dir=${dir}/profile`, `--remote-debugging-port=${port}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
const cdpUrl = `http://localhost:${port}`;
const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

try {
  for (let i = 0; i < 300; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const launcher = createCleanLauncher();
  const opts = { headless: true, userDataDir: join(dir, "unused"), snapshotDir: dir, startUrl: site, os: "windows", blockUrls: ["*.mp4"], remote: { cdpUrl, nativePersona: true } };

  const s1 = await launcher.launch(opts);
  await sleep(1500);
  check("first session loads the site", (await s1.evaluate("document.title")) === "remote");
  check("native persona: no UA override", !/Windows NT/.test(seen[0]?.ua ?? "") || process.platform === "win32", seen[0]?.ua);
  check("navigator.webdriver is false", (await s1.evaluate("navigator.webdriver")) === false);
  await s1.evaluate("localStorage.setItem('k', 'v')");
  check("cookies() reads the remote profile", (await s1.cookies()).some((c) => c.name === "visit"));
  await s1.close();
  check("close() leaves the browser running", await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false));

  const s2 = await launcher.launch(opts);
  await sleep(1500);
  check("next session replaces the leftover tab", (await pages()).length === 1, `${(await pages()).length} page(s)`);
  check("the profile kept the cookie", seen.at(-1)?.cookie.includes("visit=1"), seen.at(-1)?.cookie);
  await s2.close();

  const wiped = await wipeRemoteBrowser(cdpUrl, [site]);
  console.log("wipe:", JSON.stringify(wiped));
  const before = seen.length;
  const s3 = await launcher.launch(opts);
  await sleep(1500);
  // The page's own request: later ones (favicon) carry the cookie its response just set again.
  const first = seen.slice(before).find((r) => r.url === "/");
  check("after the wipe the site sees no cookie", first?.cookie === "", first?.cookie);
  check("after the wipe localStorage is empty", (await s3.evaluate("localStorage.getItem('k')")) === null);
  await s3.close();
  process.exitCode = checks.every(Boolean) ? 0 : 1;
} finally {
  browserProc.kill("SIGTERM");
  server.close();
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
