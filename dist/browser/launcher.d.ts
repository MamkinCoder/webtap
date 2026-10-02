import type { BrowserLauncher, WebtapLLM } from "../types.js";
/** A visible (headful) Chrome needs a screen. On a Linux box without one this starts one virtual screen, Xvfb, for
 * the life of the process and points DISPLAY at it; Chrome inherits the env. False when there is no display and no
 * Xvfb: the caller falls back to headless. */
export declare function ensureDisplay(): Promise<boolean>;
/** The first installed Chrome / Chromium in the usual places. Needed up front: the desktop user agent is derived from
 * the binary's version, and without it headless Chrome says "HeadlessChrome" (anti-bot checks reject it). */
export declare function findChrome(): string | undefined;
/** The desktop user agent of this Chromium build, in Chrome's reduced form: headless says "HeadlessChrome" (a bot
 * tell sites read). Set as a launch flag, so navigator.userAgentData keeps the browser's own client hints. */
export declare function desktopUserAgent(executablePath: string | undefined): string;
export declare function createLauncher(llm?: WebtapLLM): BrowserLauncher;
