/**
 * Per-thread context snapshots for the thread context map (ADR-0021).
 *
 * Session-lived and derived: each committed conversation store folds its own
 * rows (`ThreadContextFold`) and records the result here, with the runs on its
 * displayed branch. Nothing here is persisted; a reload refolds the log.
 */
import { create } from 'zustand';
import type { ThreadContextSnapshot } from './thread-context-fold';

export interface ThreadContextRecord {
  /** The displayed branch's runs, root first. */
  readonly branchRunIds: readonly string[];
  readonly snapshot: ThreadContextSnapshot;
}

interface ThreadContextState {
  readonly byThread: Readonly<Record<string, ThreadContextRecord>>;
  clearThread: (threadId: string) => void;
  record: (threadId: string, record: ThreadContextRecord) => void;
}

export const useThreadContextStore = create<ThreadContextState>((set) => ({
  byThread: {},
  clearThread: (threadId) =>
    set((state) => {
      if (!(threadId in state.byThread)) {
        return state;
      }
      const { [threadId]: _cleared, ...rest } = state.byThread;
      return { byThread: rest };
    }),
  record: (threadId, record) =>
    set((state) => ({ byThread: { ...state.byThread, [threadId]: record } })),
}));

export function resetThreadContextStore(): void {
  useThreadContextStore.setState({ byThread: {} });
}
