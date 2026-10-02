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
    { id: "mts-1", proxy: { server: "http://10.0.0.5:3128", username: "u", password: "p" } },
  ],
});
```

Each (identity, site) pair keeps a warm Chromium with a persistent profile, so solved challenges survive between calls
and restarts. `browser.maxSessions` caps concurrent Chromium processes; idle sessions close after `browser.idleMs`.

## Defining a site

```ts
import { z } from "zod";
import { defineSite, endpoint, http, pageFetch } from "@mamkincoder/webtap";

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

Requires Node ≥ 22.19 and a local Chrome or Chromium (`browser.executablePath`) for `pageFetch` and `browser`
strategies.

## Roadmap

- **Mapper:** an agent that drives a site, records its network traffic, and drafts the site file (strategies,
  schemas, canary) for a human to review.
- **Shared state** for several workers: identity slots, breakers and the action cache in Redis or Postgres (the
  in-memory classes are the interfaces).
- Browser-solved tokens reused by plain HTTP with a Chrome-like TLS fingerprint.
- Re-mapping triggered by canary failures.

## Use responsibly

webtap makes the same requests a person's browser would, at a pace you set. Respect sites' terms and robots rules,
keep rate limits low, don't collect personal data you have no basis for, and prefer official APIs where they exist.

## License

MIT
