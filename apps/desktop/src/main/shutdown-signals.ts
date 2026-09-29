/** What the handlers register on: `process`, or a fake in a test. */
export interface ShutdownSignalTarget {
  listeners(signal: NodeJS.Signals): readonly { readonly name: string }[];
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeAllListeners(signal: NodeJS.Signals): unknown;
}

export interface ShutdownSignalLogger {
  info(message: string, data: Record<string, unknown>): void;
}

export interface ShutdownSignalOptions {
  readonly logger: ShutdownSignalLogger;
  /** Starts the graceful shutdown. Called once, with the first signal to arrive. */
  readonly onFirstSignal: (signal: NodeJS.Signals) => void;
  readonly signals: readonly NodeJS.Signals[];
  readonly target: ShutdownSignalTarget;
}

/**
 * Persistent listeners, first signal wins. Electron converts the first SIGINT/SIGTERM/SIGHUP into
 * `app.quit()` with its own one-shot handler, after which a second signal takes the default action
 * and kills main mid-shutdown, before the durable log flushes. A dev tree (a tty process group,
 * `concurrently`'s tree-kill, turbo) delivers the same signal to main more than once. A later
 * signal is logged and ignored: it does NOT force-quit, because the forced-exit deadline already
 * bounds the run and forcing mid-close is the failure being avoided.
 *
 * Call this after Electron is ready. Electron installs its handler after module load, and Node
 * arms libuv's watcher for a signal only when its FIRST listener is added. A watcher armed earlier
 * (`when-exit`, through `electron-store`, uses `process.once` and re-raises the signal against the
 * process) is displaced by Electron's and never fires, so a plain `process.on` would be dead.
 * Dropping the existing listeners closes that watcher; ours is then the first and arms a fresh one
 * after Electron's. The dropped listeners are not restored: they exist to die by the signal, and
 * this shutdown ends through `app.quit()`, where their `exit` hooks still run.
 */
export function installShutdownSignalHandlers(options: ShutdownSignalOptions): void {
  const { logger, onFirstSignal, signals, target } = options;
  let shutdownStarted = false;
  for (const signal of signals) {
    // Named, so the log says WHO was displaced (`when-exit`'s hook, say), not just how many.
    const replaced = target.listeners(signal).map((listener) => listener.name || '<anonymous>');
    target.removeAllListeners(signal);
    target.on(signal, () => {
      if (shutdownStarted) {
        logger.info('Shutdown already in progress; ignoring signal', { signal });
        return;
      }
      shutdownStarted = true;
      onFirstSignal(signal);
    });
    if (replaced.length > 0) {
      logger.info('Replaced existing signal listeners with the shutdown handler', {
        replaced,
        signal,
      });
    }
  }
}
