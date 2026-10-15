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

/** The record for a fold's snapshot and branch: `previous` itself when neither changed. */
export function nextThreadContextRecord(
  previous: ThreadContextRecord | undefined,
  snapshot: ThreadContextSnapshot,
  branchRunIds: readonly string[]
): ThreadContextRecord {
  return previous &&
    previous.snapshot === snapshot &&
    previous.branchRunIds.join('\n') === branchRunIds.join('\n')
    ? previous
    : { branchRunIds, snapshot };
}

/**
 * The composer ring's figure for a thread, written only by `ContextUsageMeter`
 * so the Context tab shows the same total and budget without recomputing it.
 */
export interface ContextRingFigure {
  /** The effective input budget the ring divides by. */
  readonly budgetTokens: number;
  readonly isEstimated: boolean;
  readonly usedTokens: number;
}

interface ThreadContextState {
  readonly byThread: Readonly<Record<string, ThreadContextRecord>>;
  clearThread: (threadId: string) => void;
  record: (threadId: string, record: ThreadContextRecord) => void;
  recordRing: (threadId: string, figure: ContextRingFigure) => void;
  readonly ringByThread: Readonly<Record<string, ContextRingFigure>>;
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
  recordRing: (threadId, figure) =>
    set((state) => {
      const current = state.ringByThread[threadId];
      if (
        current?.budgetTokens === figure.budgetTokens &&
        current.isEstimated === figure.isEstimated &&
        current.usedTokens === figure.usedTokens
      ) {
        return state;
      }
      return { ringByThread: { ...state.ringByThread, [threadId]: figure } };
    }),
  ringByThread: {},
}));

export function resetThreadContextStore(): void {
  useThreadContextStore.setState({ byThread: {}, ringByThread: {} });
}
