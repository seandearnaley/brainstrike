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
 * An install that stopped part-way. A signal already `installed` keeps our handler. For the failed
 * one, `removedListeners` means `removeAllListeners` returned: its previous listeners are gone, so
 * it takes its default action. When false, that call did not return, and whether it removed any
 * listener before throwing is unknown (Node's implementation makes that practically unreachable).
 */
export class ShutdownSignalInstallError extends Error {
  readonly failedSignal: NodeJS.Signals;
  readonly installed: readonly NodeJS.Signals[];
  readonly removedListeners: boolean;

  constructor(options: {
    readonly cause: unknown;
    readonly failedSignal: NodeJS.Signals;
    readonly installed: readonly NodeJS.Signals[];
    readonly removedListeners: boolean;
  }) {
    const { cause, failedSignal, installed, removedListeners } = options;
    super(
      `Could not install the shutdown handler for ${failedSignal} ${removedListeners ? 'after removing' : 'before removing'} its listeners; installed: ${installed.join(', ') || 'none'}`,
      { cause }
    );
    this.name = 'ShutdownSignalInstallError';
    this.failedSignal = failedSignal;
    this.installed = installed;
    this.removedListeners = removedListeners;
  }
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
  // A diagnostic must never break shutdown: a throwing logger cannot leave a signal uninstalled, nor
  // escape from inside a signal listener.
  const logSafely = (message: string, data: Record<string, unknown>): void => {
    try {
      logger.info(message, data);
    } catch {
      // Nothing left to report a broken logger to; the handlers are what matter.
    }
  };
  let shutdownStarted = false;
  const replacements: { readonly replaced: readonly string[]; readonly signal: NodeJS.Signals }[] =
    [];
  const installed: NodeJS.Signals[] = [];
  try {
    for (const signal of signals) {
      let removedListeners = false;
      try {
        // Named, so the log says WHO was displaced (`when-exit`'s hook, say), not just how many.
        const replaced = target.listeners(signal).map((listener) => listener.name || '<anonymous>');
        target.removeAllListeners(signal);
        removedListeners = true;
        if (replaced.length > 0) {
          replacements.push({ replaced, signal });
        }
        target.on(signal, () => {
          if (shutdownStarted) {
            logSafely('Shutdown already in progress; ignoring signal', { signal });
            return;
          }
          shutdownStarted = true;
          onFirstSignal(signal);
        });
      } catch (error) {
        throw new ShutdownSignalInstallError({
          cause: error,
          failedSignal: signal,
          installed: [...installed],
          removedListeners,
        });
      }
      installed.push(signal);
    }
  } finally {
    // After every signal is installed (or the install failed), so no log can leave one
    // uninstalled and a partial install still records every listener it displaced.
    for (const { replaced, signal } of replacements) {
      logSafely('Replaced existing signal listeners with the shutdown handler', {
        replaced,
        signal,
      });
    }
  }
}
