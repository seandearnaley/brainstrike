/**
 * ADR-0034 decision 3: the Explorer's header changes where the active thread works through the
 * composer's where-control, never through a menu of its own, so the thread binding stays the one
 * writer and `useWorkspaceBar` runs once per composer. This is the only thing the two share, by
 * thread: whether that thread's where-control is shown, and a count the header raises to open it.
 * Inactive thread tabs keep their composers mounted, hidden, so a request names its thread and
 * no other thread's where-control opens.
 *
 * In memory only: nothing here outlives the window.
 */
import { create } from 'zustand';

interface WhereControlRequests {
  /** By thread id: raised to open that thread's where-control (`WorkspaceBarProps.openRequest`). */
  readonly requests: Readonly<Record<string, number>>;
  /** By thread id: its composer workspace bars shown now; the header offers its control while one is. */
  readonly shown: Readonly<Record<string, number>>;
}

export const useWhereControlRequests = create<WhereControlRequests>(() => ({
  requests: {},
  shown: {},
}));

function counted(counts: Readonly<Record<string, number>>, threadId: string, by: number) {
  const next = (counts[threadId] ?? 0) + by;
  const { [threadId]: _removed, ...rest } = counts;
  return next > 0 ? { ...rest, [threadId]: next } : rest;
}

/** `threadId`'s composer workspace bar is shown; the returned function says it is gone. */
export function showWhereControl(threadId: string): () => void {
  useWhereControlRequests.setState((state) => ({ shown: counted(state.shown, threadId, 1) }));
  return () => {
    useWhereControlRequests.setState((state) => ({ shown: counted(state.shown, threadId, -1) }));
  };
}

/** Opens `threadId`'s shown where-control. */
export function requestWhereControlOpen(threadId: string): void {
  useWhereControlRequests.setState((state) => ({
    requests: counted(state.requests, threadId, 1),
  }));
}
