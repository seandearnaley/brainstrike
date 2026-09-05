/**
 * The ONE holder of IPC-domain disposers in Electron main (BST-1648 step 4).
 * Owned by `main.ts`'s shutdown path: every `registerXIpcHandlers(...)`
 * disposer is pushed here instead of into its own `let unregisterX` slot,
 * and `will-quit` unwinds the stack instead of a hand-written per-domain
 * ladder. Bookkeeping only — `runGracefulShutdown` (the deep module) is
 * untouched and still runs BEFORE `will-quit`; disposers that must unwind
 * inside a graceful step (forge) stay there.
 *
 * `disposeAll` unwinds in LIFO order and isolates every throw: a failing
 * disposer never prevents a later one from running, and each failure is
 * returned by label so the caller logs it visibly. A handle disposes its own
 * entry once (per-window rebinding, e.g. the browser pane) and is a no-op
 * afterwards. A second live entry under the same label is a registration
 * error, never a silent double-registration.
 */
export interface DisposerHandle {
  readonly dispose: () => void;
  readonly label: string;
}

export interface DisposerFailure {
  readonly error: unknown;
  readonly label: string;
}

export interface DisposerStack {
  readonly add: (label: string, dispose: () => void) => DisposerHandle;
  readonly disposeAll: () => readonly DisposerFailure[];
  readonly labels: () => readonly string[];
}

interface Entry {
  readonly dispose: () => void;
  readonly label: string;
}

export function createDisposerStack(): DisposerStack {
  const entries: Entry[] = [];

  function remove(entry: Entry): boolean {
    const index = entries.indexOf(entry);
    if (index === -1) {
      return false;
    }
    entries.splice(index, 1);
    return true;
  }

  function add(label: string, dispose: () => void): DisposerHandle {
    if (label.trim().length === 0) {
      throw new Error('Disposer label must be a non-empty string.');
    }
    if (entries.some((entry) => entry.label === label)) {
      throw new Error(`Disposer "${label}" is already registered.`);
    }
    const entry: Entry = { dispose, label };
    entries.push(entry);
    return {
      dispose: () => {
        if (remove(entry)) {
          entry.dispose();
        }
      },
      label,
    };
  }

  function disposeAll(): readonly DisposerFailure[] {
    const failures: DisposerFailure[] = [];
    while (entries.length > 0) {
      const entry = entries.pop();
      if (!entry) {
        break;
      }
      try {
        entry.dispose();
      } catch (error) {
        failures.push({ error, label: entry.label });
      }
    }
    return failures;
  }

  return {
    add,
    disposeAll,
    labels: () => entries.map((entry) => entry.label),
  };
}
