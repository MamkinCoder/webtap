export declare function chromiumTreeRssMB(userDataDir: string): Promise<number>;
/** SIGKILLs whatever is still running for this profile after the normal close path. */
export declare function killChromiumLeftovers(userDataDir: string): Promise<number>;
