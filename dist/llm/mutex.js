// FIFO mutex / semaphore: caps concurrent LLM calls (a local `claude -p` per call is heavy on small machines).
export class Semaphore {
    max;
    active = 0;
    waiting = [];
    constructor(max = 1) {
        this.max = max;
    }
    async run(fn) {
        if (this.active >= this.max)
            await new Promise((resolve) => this.waiting.push(resolve));
        this.active++;
        try {
            return await fn();
        }
        finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}
//# sourceMappingURL=mutex.js.map