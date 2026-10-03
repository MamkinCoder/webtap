import type { BrowserLauncher, BrowserOptions, BrowserSession, PersonaOs } from "../types.js";
export interface CleanLaunchOptions extends BrowserOptions {
    /** The first page Chrome opens by itself (before any CDP command touches a page). */
    startUrl?: string;
}
/** LANG / LANGUAGE for a BCP 47 tag: "ru-RU" → ru_RU.UTF-8 and ru_RU:ru. */
export declare function localeEnv(tag: string | undefined): Record<string, string>;
/** Sets one value in the profile's Default/Preferences before Chrome starts (Chrome keeps the other keys). */
export declare function setPreference(userDataDir: string, path: string[], value: unknown): void;
/** The reduced user agent and client hints of Chrome `major` on `os`, as that Chrome sends them. */
export declare function personaFor(os: PersonaOs, major: string): {
    userAgent: string;
    platform: string;
    metadata: {
        platform: string;
        platformVersion: string;
        architecture: string;
        bitness: string;
        model: string;
        mobile: boolean;
        wow64: boolean;
    };
};
export declare function createCleanLauncher(): BrowserLauncher & {
    launch(opts: CleanLaunchOptions): Promise<BrowserSession>;
};
