// Public surface.
// webtap ships its own zod 4; define site schemas with this `z` so they match the runtime's types, whatever zod
// version the host app uses.
export { z } from "zod";
export { createWebtap, defaultCanaryCheck, WebtapError } from "./runtime/webtap.js";
export type { Attempt, CallResult, EndpointInfo, HealthReport, Webtap, WebtapErrorCode, WebtapEvent, WebtapOptions } from "./runtime/webtap.js";
export { defineSite, endpoint } from "./runtime/site.js";
export type { Endpoint, HttpRequest, HttpResponse, Identity, SiteDef, Strategy, StrategyContext, StrategyKind } from "./runtime/site.js";
export { browser, http, pageFetch, requests } from "./runtime/strategies.js";
export type { FetchJson } from "./runtime/strategies.js";
export { StrategyFailure, banned, changed, transient, classifyResponse, looksLikeChallenge, parseJsonBody } from "./runtime/outcome.js";
export type { Outcome } from "./runtime/outcome.js";
export type { CanaryResult, EndpointHealth, EndpointStatus, StrategyStats } from "./runtime/health.js";
export type { IdentitySiteStatus } from "./runtime/identity.js";
export { createServer } from "./server.js";
export type { ServerOptions } from "./server.js";

// Browser layer, usable on its own.
export { createLauncher, desktopUserAgent, findChrome } from "./browser/launcher.js";
export { createCleanLauncher } from "./browser/clean.js";
export { ActionCache } from "./browser/cache.js";
export type * from "./types.js";

// The mapper: site + goal + sample inputs → a site file.
export { mapSite } from "./mapper/index.js";
export type { MapOptions, MapReport, MapResult } from "./mapper/index.js";

// LLM providers.
export { claudeCli } from "./llm/claude-cli.js";
export type { ClaudeCliOptions } from "./llm/claude-cli.js";
export { openaiCompatible } from "./llm/openai.js";
export type { OpenAICompatibleOptions } from "./llm/openai.js";
