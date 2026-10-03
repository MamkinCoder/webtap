import type { BrowserLauncher, BrowserOptions, BrowserSession } from "../types.js";
export interface CleanLaunchOptions extends BrowserOptions {
    /** The first page Chrome opens by itself (before any CDP command touches a page). */
    startUrl?: string;
}
/** LANG / LANGUAGE for a BCP 47 tag: "ru-RU" → ru_RU.UTF-8 and ru_RU:ru. */
export declare function localeEnv(tag: string | undefined): Record<string, string>;
/** Sets one value in the profile's Default/Preferences before Chrome starts (Chrome keeps the other keys). */
export declare function setPreference(userDataDir: string, path: string[], value: unknown): void;
export declare function createCleanLauncher(): BrowserLauncher & {
    launch(opts: CleanLaunchOptions): Promise<BrowserSession>;
};
