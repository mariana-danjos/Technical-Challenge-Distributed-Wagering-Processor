import { Logger } from '@nestjs/common';

/**
 * Runs `tick` repeatedly. When a tick reports more work it runs again immediately; otherwise it
 * sleeps `idleMs`. Errors are logged and followed by an idle sleep. stop() wakes a sleeping loop and
 * waits for the current tick to finish.
 */
export class PollingLoop {
  private readonly logger: Logger;
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly idleMs: number,
  ) {
    this.logger = new Logger(`PollingLoop:${name}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let moreWork = false;
      try {
        moreWork = await this.tick();
      } catch (error) {
        this.logger.error({ err: error }, 'Tick failed');
      }
      if (!moreWork && this.running) await this.sleep(this.idleMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
