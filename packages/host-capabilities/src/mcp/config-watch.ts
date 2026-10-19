import { createLogger } from '@brainstrike/logging';
import { errorMessage } from './config-file.js';

const logger = createLogger('McpConfigWatch');

/**
 * The MCP config watcher's health, held by the settings authority: whether its
 * lifecycle wants a watcher, and why the wanted watcher cannot run. The
 * authority keeps the watcher itself, its lifecycle and its epochs.
 */
export class McpConfigWatchHealth {
  #wanted = false;
  #error: string | null = null;

  /** Why the wanted watcher cannot run; config status carries it until it runs again. */
  get error(): string | null {
    return this.#error;
  }

  /** The lifecycle keeps a config watcher: from `start` until a reset or shutdown. */
  want(): void {
    this.#wanted = true;
  }

  /** The held watcher failed, dying while it ran or failing to close: `error` says why until a later start succeeds. */
  fail(cause: unknown): void {
    this.#error = errorMessage(cause);
  }

  /**
   * Stops the held watcher with `stop`, never throwing: a close that throws is
   * the watcher's failure, as `fail` records it. Returns whether it stopped.
   */
  stop(stop: () => void): boolean {
    try {
      stop();
      return true;
    } catch (cause) {
      logger.error('MCP config watcher could not be stopped', { error: cause });
      this.fail(cause);
      return false;
    }
  }

  /** A retired lifecycle wants no watcher, so none can be failing. */
  retire(): void {
    this.#wanted = false;
    this.#error = null;
  }

  /**
   * Starts the wanted watcher when none is `running`, and records how that
   * went. It never throws, and records nothing once the lifecycle is no longer
   * `current`. Resolves whether `error` changed.
   */
  async ensure(watch: {
    readonly current: () => boolean;
    readonly running: boolean;
    readonly start: () => Promise<void>;
  }): Promise<boolean> {
    if (!this.#wanted || watch.running) {
      return false;
    }
    let error: string | null = null;
    try {
      await watch.start();
    } catch (cause) {
      logger.error('MCP config watcher cannot run', { error: cause });
      error = errorMessage(cause);
    }
    if (error === this.#error || !watch.current()) {
      return false;
    }
    this.#error = error;
    return true;
  }
}
