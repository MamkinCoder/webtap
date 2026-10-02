// Browser and LLM contracts. Site code is written against BrowserSession only; nothing outside src/browser imports
// Stagehand.
import type { ZodType } from "zod";

export interface ProxyConfig {
  /** "http://host:port" or "socks5://host:port". */
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserOptions {
  /** Chrome / Chromium binary. Omitted: Stagehand looks for a local Chrome. */
  executablePath?: string;
  headless: boolean;
  /** Persistent profile dir, so cookies and solved challenges survive restarts. Also used to find the process tree. */
  userDataDir: string;
  /** Override the derived desktop UA. Default: Chrome's reduced UA for this build (never "HeadlessChrome"). */
  userAgent?: string;
  /** Where snapshot() writes its html/png/url bundles. */
  snapshotDir: string;
  /** Action cache shared by every session of a runtime. Omitted: a memory-only cache for this session. */
  cache?: import("./browser/cache.js").ActionCache;
  /** Block images/fonts/media/analytics over CDP (RAM and proxy traffic). */
  blockAssets?: boolean;
  /** Keep images even with blockAssets (a browser that never loads images is a bot tell for some spam filters). */
  loadImages?: boolean;
  /** Extra Network.setBlockedURLs patterns, e.g. "*wp-json*" to reproduce a flow with sending blocked. */
  blockUrls?: string[];
  /** Omitted: Chromium goes direct and ignores HTTP(S)_PROXY from the environment. */
  proxy?: ProxyConfig;
  /** Accept-Language / navigator.languages, most preferred first. Default ["ru-RU", "ru", "en-US", "en"]. */
  languages?: string[];
  viewport?: { width: number; height: number };
  /** Default 15000. */
  actionTimeoutMs?: number;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Result of observe(): a concrete element the LLM chose for an instruction. */
export interface Observed {
  selector: string; // xpath or css as returned by Stagehand
  description: string;
  method?: string; // click | fill | selectOptionFromDropdown ...
  arguments?: string[];
}

export interface ActResult {
  success: boolean;
  message: string;
  usedCache: boolean;
  /** The element the action ran on (cached or observed), when there was one. */
  selector?: string;
}

export interface ActOptions {
  /** Stable step name, e.g. "search.submit". Default: the instruction text. Rewording the instruction keeps the cache. */
  cacheKey?: string;
  /** `%name%` placeholders in the instruction; stored as placeholders, substituted at replay. */
  variables?: Record<string, string>;
  timeoutMs?: number;
}

/** What a fetch made inside the page returned. */
export interface PageFetchResult {
  status: number;
  url: string;
  contentType: string;
  body: string;
}

/**
 * One Chromium instance, one active page. NOT safe for concurrent use: the runtime's browser pool serialises calls.
 */
export interface BrowserSession {
  /** `quick`: DOM ready only; default also waits for load + a short network idle. */
  goto(url: string, opts?: { quick?: boolean }): Promise<void>;
  url(): Promise<string>;
  html(): Promise<string>;
  /** Visible text of the page (innerText), capped. */
  text(maxChars?: number): Promise<string>;

  /**
   * Perform an action described in natural language. Action cache first (key = cacheKey ?? instruction, scoped by
   * host); on a miss the LLM picks the element via observe(), it is performed and the selector is saved. A replay that
   * fails is healed: one observe, perform, re-save. Concurrent heals of the same step share one LLM call.
   */
  act(instruction: string, opts?: ActOptions): Promise<ActResult>;
  /** Extract structured data validated by a zod schema (one LLM call, not cached). */
  extract<T>(instruction: string, schema: ZodType<T>, opts?: { timeoutMs?: number }): Promise<T>;
  /** Find elements for an instruction without acting. */
  observe(instruction: string): Promise<Observed[]>;
  /** fetch() from inside the page: the browser's own TLS, cookies, origin and anti-bot tokens. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<PageFetchResult>;

  // Cheap deterministic helpers (no LLM): use them wherever a stable selector is known.
  exists(selector: string): Promise<boolean>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>; // React-safe (native setter + input event)
  upload(selector: string, filePath: string): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<boolean>;
  waitForSelector(selector: string, timeoutMs: number): Promise<boolean>;
  evaluate<T = unknown>(js: string): Promise<T>;
  pressEscape(): Promise<void>;
  pressKey(key: string): Promise<void>;
  /** Human-like presence before a scored action: wheel scrolls, curved mouse paths to each target (css / xpath),
   * idling until `ms` has passed. Best effort: never throws. */
  humanize(targets: string[], ms: number): Promise<void>;
  /** Re-enters a filled field like a person: mouse to it, click, clear, type its value with human delays and corrected
   * typos. Restores the value and returns false when the typed result differs. */
  retype(selector: string): Promise<boolean>;

  /** Writes <snapshotDir>/<name>.html, .png, .url; returns the html path. */
  snapshot(name: string): Promise<string>;
  cookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
  /** Approximate RSS of the browser process tree in MB (0 if unknown). */
  memoryMB(): Promise<number>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(opts: BrowserOptions): Promise<BrowserSession>;
}

/** The text-completion contract webtap needs from a model. Providers: claudeCli(), openaiCompatible(), or your own. */
export interface WebtapLLM {
  generate(params: LLMParams): Promise<{ text: string; structured?: unknown }>;
}

export interface LLMParams {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  systemPrompt?: string;
  temperature?: number;
  responseFormat?: { type: "json_schema"; schema: unknown } | { type: "text" };
}

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
