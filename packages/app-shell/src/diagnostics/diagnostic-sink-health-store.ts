import { create } from 'zustand';

/**
 * Sink-health flag backing the settings banner (Task 5).
 *
 * `DiagnosticSinkBridge` mounts inside `<DbProvider>` but OUTSIDE
 * `RootLayoutContent`, so React context cannot carry a sink-disabled signal
 * up to the settings UI — a module-level store is the only channel. The
 * writer's own `onDisabled` callback is ALSO the only place this can ever be
 * observed: both places that convert `LogRecord`s into diagnostic events
 * skip records scoped to `DIAGNOSTIC_SINK_SCOPE` (a loop guard preventing the
 * sink logging its own failure back into itself), so the sink's failure can
 * never reach the durable table or the Log Viewer any other way.
 *
 * `markDisabled` is idempotent — the FIRST reason wins, because later
 * failures after disablement (e.g. a subsequent flush attempt racing the
 * disable) must not overwrite the original root cause shown to the user.
 * Session-only; registered with factory reset in
 * `register-factory-reset-session-stores.ts`.
 *
 * KNOWN GAP: nothing in production calls `clear()` — the banner's "restart
 * re-enables capture" copy is accurate for the normal case, but the bridge
 * DOES rebuild its writer when the db handle identity changes (e.g. after
 * runtime corruption recovery swaps the database), so capture can resume
 * while the flag stays set. That direction is a stale OVER-warning, which
 * is the safe way to be wrong here — the opposite (clearing the flag while
 * capture is still dead) would be a silent all-clear. Wiring `clear()` into
 * the bridge's writer-construction path is the fix if this becomes a real
 * annoyance; it is deliberately not done blind.
 */
export interface DiagnosticSinkHealthState {
  clear: () => void;
  disabledReason: string | null;
  markDisabled: (reason: string) => void;
}

const initialDiagnosticSinkHealthState: Pick<DiagnosticSinkHealthState, 'disabledReason'> = {
  disabledReason: null,
};

export const useDiagnosticSinkHealthStore = create<DiagnosticSinkHealthState>((set, get) => ({
  ...initialDiagnosticSinkHealthState,
  clear: () => set({ disabledReason: null }),
  markDisabled: (reason) => {
    if (get().disabledReason !== null) {
      return; // idempotent: first reason wins, never overwritten by a later failure
    }
    set({ disabledReason: reason });
  },
}));

/** Clears the sink-health flag (session reset / factory reset). */
export function resetDiagnosticSinkHealthStore(): void {
  useDiagnosticSinkHealthStore.setState(initialDiagnosticSinkHealthState);
}
