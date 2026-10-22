import { create } from 'zustand';

/**
 * Unseen-diagnostics watermark backing the status-bar chip (Task 3): the chip
 * counts this launch's warn+ diagnostic events whose `occurredAt` is after
 * `lastSeenAtMs`, the moment the person last opened the chip (0 until then).
 *
 * Main owns where a launch begins: `getUnseenCounts` counts nothing from before
 * Main's process started. So an error Main logs before this window loads still
 * counts, and retained rows from earlier launches (up to 20k, per the retention
 * cap) never come back as unread on a restart. Session-only; registered with
 * factory reset in `register-factory-reset-session-stores.ts`.
 */
export interface DiagnosticsSeenState {
  lastSeenAtMs: number;
  markAllSeen: (nowMs: number) => void;
}

function initialDiagnosticsSeenState(): Pick<DiagnosticsSeenState, 'lastSeenAtMs'> {
  return { lastSeenAtMs: 0 };
}

export const useDiagnosticsSeenStore = create<DiagnosticsSeenState>((set) => ({
  ...initialDiagnosticsSeenState(),
  markAllSeen: (nowMs) => set({ lastSeenAtMs: nowMs }),
}));

/** Forgets the person's last look (session reset / factory reset). */
export function resetDiagnosticsSeenStore(): void {
  useDiagnosticsSeenStore.setState(initialDiagnosticsSeenState());
}
