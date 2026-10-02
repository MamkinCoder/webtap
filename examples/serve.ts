// Runs the example sites behind the HTTP API.
//
//   npx tsx examples/serve.ts
//   curl -s localhost:7070/sites/yandex-eda/search -d '{"query":"бургер","latitude":55.75,"longitude":37.62}'
//
// Env: PORT (7070), WEBTAP_TOKEN (optional bearer token), CHROME_PATH, WEBTAP_HEADFUL=1,
//      WEBTAP_PROXIES="id=http://user:pass@host:port,id2=…" (default: this machine's IP),
//      LLM for browser fallbacks: WEBTAP_LLM=claude (uses `claude -p`) or OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL.
import { claudeCli, createServer, createWebtap, openaiCompatible, type Identity, type WebtapLLM } from "../src/index.js";
import { wildberries } from "./sites/wildberries.js";
import { yandexEda } from "./sites/yandex-eda.js";

function identitiesFromEnv(): Identity[] | undefined {
  const raw = process.env.WEBTAP_PROXIES?.trim();
  if (!raw) return undefined;
  return raw.split(",").map((entry) => {
    const [id, url] = entry.split("=", 2) as [string, string];
    const u = new URL(url);
    return {
      id,
      proxy: {
        server: `${u.protocol}//${u.host}`,
        ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
      },
    };
  });
}

function llmFromEnv(): WebtapLLM | undefined {
  if (process.env.WEBTAP_LLM === "claude") return claudeCli();
  const { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: apiKey, OPENAI_MODEL: model } = process.env;
  if (baseUrl && apiKey && model) return openaiCompatible({ baseUrl, apiKey, model });
  return undefined;
}

const identities = identitiesFromEnv();
const llm = llmFromEnv();
const webtap = createWebtap({
  sites: [wildberries, yandexEda],
  ...(identities ? { identities } : {}),
  ...(llm ? { llm } : {}),
  browser: {
    headless: process.env.WEBTAP_HEADFUL !== "1",
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  },
  onEvent: (e) => {
    if (e.type === "call") console.log(`${e.ok ? "ok  " : "FAIL"} ${e.site}/${e.endpoint} ${e.strategy ?? ""} ${e.ms}ms ${e.message ?? ""}`);
  },
});

const port = Number(process.env.PORT ?? 7070);
const server = createServer(webtap, process.env.WEBTAP_TOKEN ? { token: process.env.WEBTAP_TOKEN } : {});
server.listen(port, () => console.log(`webtap on :${port} — sites: ${webtap.describe().map((e) => `${e.site}/${e.endpoint}`).join(", ")}`));

// Canaries every 10 minutes: breakage shows up in /health before callers notice.
const canaries = setInterval(() => void webtap.runCanaries().catch(() => undefined), 10 * 60_000);

const shutdown = async () => {
  clearInterval(canaries);
  server.close();
  await webtap.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
