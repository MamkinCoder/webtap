// Public surface.
export { createWebtap, defaultCanaryCheck, WebtapError } from "./runtime/webtap.js";
export type { Attempt, CallResult, EndpointInfo, HealthReport, Webtap, WebtapErrorCode, WebtapEvent, WebtapOptions } from "./runtime/webtap.js";
export { defineSite, endpoint } from "./runtime/site.js";
export type { Endpoint, HttpRequest, HttpResponse, Identity, SiteDef, Strategy, StrategyContext, StrategyKind } from "./runtime/site.js";
export { browser, http, pageFetch } from "./runtime/strategies.js";
export { StrategyFailure, banned, changed, transient, classifyResponse, looksLikeChallenge, parseJsonBody } from "./runtime/outcome.js";
export type { Outcome } from "./runtime/outcome.js";
export type { CanaryResult, EndpointHealth, EndpointStatus, StrategyStats } from "./runtime/health.js";
export type { IdentitySiteStatus } from "./runtime/identity.js";
export { createServer } from "./server.js";
export type { ServerOptions } from "./server.js";

// Browser layer, usable on its own.
export { createLauncher, desktopUserAgent } from "./browser/launcher.js";
export { ActionCache } from "./browser/cache.js";
export type * from "./types.js";

// LLM providers.
export { claudeCli } from "./llm/claude-cli.js";
export type { ClaudeCliOptions } from "./llm/claude-cli.js";
export { openaiCompatible } from "./llm/openai.js";
export type { OpenAICompatibleOptions } from "./llm/openai.js";
