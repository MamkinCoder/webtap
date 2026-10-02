import type { BrowserLauncher, BrowserOptions, BrowserSession } from "../types.js";
export interface CleanLaunchOptions extends BrowserOptions {
    /** The first page Chrome opens by itself (before any CDP command touches a page). */
    startUrl?: string;
}
export declare function createCleanLauncher(): BrowserLauncher & {
    launch(opts: CleanLaunchOptions): Promise<BrowserSession>;
};
