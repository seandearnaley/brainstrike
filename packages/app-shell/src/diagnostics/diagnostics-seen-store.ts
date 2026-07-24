import { create } from 'zustand';

/**
 * Unseen-diagnostics watermark backing the status-bar chip (Task 3): the chip
 * counts warn+ diagnostic events whose `occurredAt` is after `lastSeenAtMs`.
 *
 * The watermark is SESSION-scoped by design (design §9): it is seeded at
 * first mount (module load), so the chip counts "warn+ events since this
 * launch" rather than replaying every retained row (up to 20k, per the
 * retention cap) as unread on every restart. A persisted watermark would
 * turn every app launch into a flood of "new" errors for events the user
 * already dismissed in a prior session. Session-only; registered with
 * factory reset in `register-factory-reset-session-stores.ts`.
 */
export interface DiagnosticsSeenState {
  lastSeenAtMs: number;
  markAllSeen: (nowMs: number) => void;
}

function initialDiagnosticsSeenState(): Pick<DiagnosticsSeenState, 'lastSeenAtMs'> {
  return { lastSeenAtMs: Date.now() };
}

export const useDiagnosticsSeenStore = create<DiagnosticsSeenState>((set) => ({
  ...initialDiagnosticsSeenState(),
  markAllSeen: (nowMs) => set({ lastSeenAtMs: nowMs }),
}));

/** Re-seeds the watermark to "now" (session reset / factory reset). */
export function resetDiagnosticsSeenStore(): void {
  useDiagnosticsSeenStore.setState(initialDiagnosticsSeenState());
}
