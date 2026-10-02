export declare class Semaphore {
    private readonly max;
    private active;
    private readonly waiting;
    constructor(max?: number);
    run<T>(fn: () => Promise<T>): Promise<T>;
}
