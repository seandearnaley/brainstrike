import { createLogger } from '@brainstrike/logging';
import { errorMessage } from './config-file.ts';

const logger = createLogger('McpConfigWatch');

/**
 * What the watch health may do with one lifecycle's config watcher. The
 * settings authority binds it to the watcher it keeps and to its epochs.
 */
export interface McpConfigWatchControl {
  /** Announces config status, carrying a changed `error`. */
  readonly announce: () => void;
  /** Whether the lifecycle this control was bound to is still the current one. */
  readonly current: () => boolean;
  /** Reloads the runtime from the config file. */
  readonly reload: () => Promise<void>;
  readonly running: () => boolean;
  /** Starts a watcher on the current config file and holds it. */
  readonly start: () => Promise<void>;
  /** Lets go of the held watcher and closes it, which may throw. */
  readonly stop: () => void;
}

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

  /**
   * The held watcher failed, dying while it ran or failing to close: `error`
   * says why until a later start succeeds.
   */
  fail(cause: unknown): void {
    this.#error = errorMessage(cause);
  }

  /**
   * Stops the held watcher, never throwing: a close that throws is the
   * watcher's failure, recorded and announced. Returns whether it stopped.
   */
  stop(watch: Pick<McpConfigWatchControl, 'announce' | 'stop'>): boolean {
    try {
      watch.stop();
      return true;
    } catch (cause) {
      logger.error('MCP config watcher could not be stopped', { error: cause });
      this.fail(cause);
      watch.announce();
      return false;
    }
  }

  /** A retired lifecycle wants no watcher, so none can be failing. */
  retire(): void {
    this.#wanted = false;
    this.#error = null;
  }

  /**
   * Starts the wanted watcher when none is running, records how that went and
   * announces a changed `error`. It never throws, and records nothing once the
   * lifecycle is no longer `current`. Resolves whether it started a watcher,
   * which saw none of the edits made while no watcher ran.
   */
  async ensure(
    watch: Pick<McpConfigWatchControl, 'announce' | 'current' | 'running' | 'start'>
  ): Promise<boolean> {
    if (!this.#wanted || watch.running()) {
      return false;
    }
    let error: string | null = null;
    try {
      await watch.start();
    } catch (cause) {
      logger.error('MCP config watcher cannot run', { error: cause });
      error = errorMessage(cause);
    }
    if (!watch.current()) {
      return false;
    }
    if (error !== this.#error) {
      this.#error = error;
      watch.announce();
    }
    return error === null;
  }

  /**
   * Reloads the edits a restarted watcher missed. A reload that fails puts the
   * watcher back down and is `error`, announced, so the next save, install or
   * read restarts it and reloads again; the failure then rethrows.
   */
  async reloadAfterRestart(
    watch: Pick<McpConfigWatchControl, 'announce' | 'current' | 'reload' | 'stop'>
  ): Promise<void> {
    try {
      await watch.reload();
    } catch (cause) {
      if (watch.current()) {
        logger.error('MCP config reload after a watcher restart failed', { error: cause });
        this.stop(watch);
        this.#error = `the MCP config could not be reloaded after its watcher restarted: ${errorMessage(cause)}`;
        watch.announce();
      }
      throw cause;
    }
  }

  /** Starts the wanted watcher when none runs and reloads what it missed (`reloadAfterRestart`). */
  async recover(watch: McpConfigWatchControl): Promise<void> {
    if (await this.ensure(watch)) {
      await this.reloadAfterRestart(watch);
    }
  }
}
