// Manual check (needs a local Chrome): the clean engine with os "windows" sends a Windows UA + client hints on the
// FIRST request and reports Win32 in the page. Run: npm run build && node test/persona.e2e.mjs
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanLauncher } from "../dist/browser/clean.js";

const seen = [];
const server = createServer((req, res) => {
  seen.push({ ua: req.headers["user-agent"], platform: req.headers["sec-ch-ua-platform"] });
  res.setHeader("Accept-CH", "Sec-CH-UA-Platform-Version");
  res.end("<!doctype html><title>t</title>ok");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const dir = mkdtempSync(join(tmpdir(), "persona-"));
const session = await createCleanLauncher().launch({ headless: true, userDataDir: dir, snapshotDir: dir, startUrl: url, os: "windows" });
try {
  await new Promise((r) => setTimeout(r, 1500));
  const page = await session.evaluate(
    `navigator.userAgentData.getHighEntropyValues(["platformVersion"]).then(function (v) {
      return JSON.stringify({ ua: navigator.userAgent, platform: navigator.platform, chPlatform: navigator.userAgentData.platform,
        platformVersion: v.platformVersion, brands: navigator.userAgentData.brands });
    })`,
  );
  // A worker has its own navigator: its platform stays the real OS (CDP cannot override it); printed for the record.
  const worker = await session.evaluate(
    `new Promise(function (resolve) {
      var w = new Worker(URL.createObjectURL(new Blob(["postMessage(navigator.platform + ' | ' + navigator.userAgent)"])));
      w.onmessage = function (e) { resolve(e.data); };
      setTimeout(function () { resolve("no answer"); }, 3000);
    })`,
  );
  console.log("worker:", worker);
  console.log("first request:", JSON.stringify(seen[0]));
  console.log("page:", page);
  const p = JSON.parse(page);
  const ok = /Windows NT 10.0/.test(seen[0]?.ua ?? "") && seen[0]?.platform === '"Windows"' && p.platform === "Win32" && p.chPlatform === "Windows" && !/Headless/.test(p.ua);
  console.log(ok ? "persona: ok" : "persona: FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  await session.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
