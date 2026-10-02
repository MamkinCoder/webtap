# webtap

Turn websites into typed APIs that keep working.

You describe a site once: its endpoints, their input and output schemas, and one or more **strategies** for getting
the data, cheapest first. webtap runs them behind `call(site, endpoint, input)` or an HTTP API and handles everything
around them: anti-bot challenges, rate limits, bans, proxies, broken selectors, fallbacks, health checks.

```ts
const r = await webtap.call("wildberries", "search", { query: "чайник", limit: 3 });
// r.data.items → [{ id, title: "Чайник электрический…", priceRub: 1150, url, … }]
// r.strategy   → "page-fetch", r.ms → 627
```

It builds on [Stagehand](https://github.com/browserbase/stagehand) for driving Chromium with an LLM, plus its own
action cache, so the LLM is only needed when something is new or has changed.

## Strategies: cheapest first

| strategy | how | cost | use when |
|---|---|---|---|
| `http()` | plain HTTP from Node through the identity's proxy | ~100 ms, KB | the site's (internal) JSON API answers plain requests |
| `pageFetch()` | the same request made by `fetch()` inside a warm browser tab | ~0.5 s warm, KB | the API sits behind an anti-bot challenge: the tab has the browser's TLS fingerprint, cookies and tokens |
| `requests()` | several dependent calls (suggest → id → search → details), over HTTP or inside the tab | ~1–2 s | the data call needs ids that earlier calls return |
| `browser()` | drive the page: `act()` with cached selectors, `extract()` with the LLM | seconds, MB | there is no usable API |

The runtime tries them in order and returns the first output that passes the endpoint's zod schema and `verify`.

## How failures are handled

Every failed attempt is classified, because each needs a different fix:

- **banned** (403/429/498, captcha or challenge page): the identity is quarantined *for that site* (10 min, doubling
  on repeats) and the call retries on another identity.
- **changed** (404, wrong JSON shape, schema or `verify` failure): the call moves on to the next strategy. Repeated
  failures open a **circuit breaker** for that strategy, so calls stop wasting time on it until a cooldown passes.
- **error** (timeouts, 5xx, network): one retry on another identity, then the next strategy.

**Selector healing:** a `browser()` strategy's `act("click search", { cacheKey: "search.submit" })` replays a cached
selector with no LLM call. When the replay fails, one LLM `observe` finds the element again and the fix is saved for
every session. Concurrent calls hitting the same broken step share that one LLM call.

**Canaries:** each endpoint can declare a known-good call. `runCanaries()` (or `POST /canaries`) runs them, and
`health()` reports per endpoint (`ok` / `degraded` = needed a fallback / `down`), per strategy (counts, latency,
breaker state, last failure) and per identity (ready / quarantined).

## Identities

An identity is an exit IP plus a browser persona. Rate limits (`minIntervalMs` per identity per site), bans and
browser profiles are tracked per identity, so capacity grows by adding identities:

```ts
createWebtap({
  sites,
  identities: [
    { id: "home" }, // this machine's IP
    { id: "mts-1", proxy: { server: "http://10.0.0.5:3128", username: "u", password: "p" }, rotateUrl: "https://…/change-ip" },
  ],
});
```

### The clean engine (sites that ban automated browsers)

Some sites catch any automated Chrome, headless or not, and ban its IP: Avito runs a proof-of-work challenge and
bans what Playwright/Stagehand-driven Chrome looks like, while a hand-started Chrome passes. For them,
`browser: { engine: "clean" }` starts a plain Chrome (no automation flags) that opens the site by itself, and drives
it with browser-level CDP plus single in-page commands that need no domain enabled (`Page.navigate`,
`Runtime.evaluate`), so nothing in the page changes. Windows stay on-screen (an off-screen window is itself a tell):
on a Linux server that is a virtual display (Xvfb). The engine has no LLM `act`/`extract`: recipes use `goto`,
`evaluate`, `fetch` and the DOM. See [`examples/sites/avito.ts`](examples/sites/avito.ts).

Proxies with credentials work on both engines (a local relay adds them; Stagehand's own browser can't take them).
`requireProxy: true` keeps a site off this machine's own IP. An identity's `rotateUrl` (mobile proxies have an
"change IP" link) is called on a ban: new IP, fresh session, a 15 s pause instead of a 30 min quarantine.

Each (identity, site) pair keeps a warm Chromium with a persistent profile, so solved challenges survive between calls
and restarts. `browser.maxSessions` caps concurrent Chromium processes; idle sessions close after `browser.idleMs`.

## Defining a site

```ts
import { defineSite, endpoint, http, pageFetch, z } from "@mamkincoder/webtap"; // webtap's own zod 4

export const flowers = defineSite({
  id: "flowers",
  origin: "https://flowers.example",
  rateLimit: { minIntervalMs: 2000 },
  endpoints: {
    search: endpoint(
      {
        input: z.object({ query: z.string(), limit: z.number().default(20) }),
        output: z.object({ items: z.array(z.object({ title: z.string(), priceRub: z.number(), url: z.string() })) }),
      },
      {
        strategies: [
          http({
            request: (i) => ({ url: `/api/search?q=${encodeURIComponent(i.query)}` }),
            parse: (json, i) => ({ items: json.products.slice(0, i.limit).map((p) => ({ title: p.name, priceRub: p.price, url: p.link })) }),
          }),
          pageFetch({ warmUrl: "/", request: …, parse: … }), // same call from inside the browser
        ],
        canary: { input: { query: "розы" } },
      },
    ),
  },
});
```

`endpoint()` takes two arguments so TypeScript fixes the input and output types from the schemas first: `request`
and `parse` are fully typed without annotations. `parse` throwing (a missing field, a TypeError) counts as
**changed**, not as a crash.

Working examples, recorded from the sites' own frontends: [`examples/sites/wildberries.ts`](examples/sites/wildberries.ts)
(page-fetch through WB's anti-bot check, LLM browser fallback) and
[`examples/sites/yandex-eda.ts`](examples/sites/yandex-eda.ts) (HTTP with a page-fetch fallback).

## Mapping a new site

`webtap map` writes a site file for you. An LLM drives the site in Chrome until it shows the results, every response
is recorded, and the request that carried the data the page showed becomes the endpoint:

```bash
WEBTAP_LLM=claude npx webtap map https://sutochno.ru/ \
  --goal "find places to stay in a city for given check-in and check-out dates, with the price for the stay" \
  --input city=Сочи --input checkIn=2026-10-16 --input checkOut=2026-10-18 \
  --fields "title,priceRub:number?,rating:number?,address?,url,imageUrl?" \
  --id sutochno --out sites/sutochno.ts
```

1. **Explore:** the agent operates the site step by step (`act`, so the elements it finds are cached). When a form
   control fights back, it uses the site's own URL patterns instead. A captcha stops the run with an error.
2. **Ground truth:** it reads a few results off the page.
3. **Find the data:** the recorded JSON response containing those results is the data request; sample input values in
   its URL and body become parameters.
4. **Chains:** if an input is missing from that request (the site turned the city into an id first), the mapper
   traces which earlier response produced each id back to a call that carries the input, e.g.
   `suggest?query=Сочи → location.id → searchObjectsOnMap → ids → searchObjectsByLocation`.
5. **Codegen, checked live:** the LLM writes the `parse` function (or the whole call chain). It runs against the
   recorded response or the live site and must reproduce the page's results, with errors fed back.
6. **Output:** a site file with the verified strategies cheapest first (`http`/`requests` over plain HTTP, then inside
   the tab) and the explored steps as the browser fallback.

The output is a draft for review: check which price it maps (per night or per stay), hard-coded tokens, and the notes
at the top. Site files belong in git; webtap's runtime state (`.webtap/`: profiles, healed selectors) does not.

LLM: `WEBTAP_LLM=claude` uses the `claude` CLI (sonnet to explore and write code, haiku for Stagehand), or set
`OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL`.

## Running it

```ts
import { createWebtap, createServer, openaiCompatible, claudeCli } from "@mamkincoder/webtap";

const webtap = createWebtap({
  sites: [flowers],
  llm: openaiCompatible({ baseUrl, apiKey, model }), // or claudeCli(): `claude -p`, no API key
  dataDir: ".webtap", // browser profiles, action cache, failure snapshots
});

createServer(webtap, { token: process.env.WEBTAP_TOKEN }).listen(7070);
```

| route | |
|---|---|
| `POST /sites/:site/:endpoint` | input JSON → `{ data, meta: { strategy, identity, ms, attempts } }`; 400 bad input, 502 every strategy failed (with the attempts) |
| `GET /sites` | endpoint catalog with JSON Schemas, e.g. to hand an LLM as tools |
| `GET /health` | endpoints, strategies, identities, browser sessions |
| `POST /canaries[?site=x&perStrategy=1]` | run the canaries now |

The example server: `npx tsx examples/serve.ts` (see the env vars at the top of the file).

The LLM is only used by `browser()` strategies, for `act` on a cache miss, `observe` and `extract`. `http` and
`pageFetch` strategies never call it.

## Install

While the API is young, install from git, pinned to a tag:

```bash
pnpm add github:MamkinCoder/webtap#v0.1.0
```

The package builds itself on install (its `prepare` script). pnpm 10 blocks dependency build scripts by default, so
allow it in `pnpm-workspace.yaml` first:

```yaml
onlyBuiltDependencies:
  - "@mamkincoder/webtap"
```

Requires Node ≥ 22.19 and a local Chrome or Chromium (`browser.executablePath`) for `pageFetch` and `browser`
strategies.

## Roadmap

- Mapper: paginated results, POST forms with CSRF tokens, re-mapping triggered by canary failures.
- **Shared state** for several workers: identity slots, breakers and the action cache in Redis or Postgres (the
  in-memory classes are the interfaces).
- Browser-solved tokens reused by plain HTTP with a Chrome-like TLS fingerprint.

## Use responsibly

webtap makes the same requests a person's browser would, at a pace you set. Respect sites' terms and robots rules,
keep rate limits low, don't collect personal data you have no basis for, and prefer official APIs where they exist.

## License

MIT
