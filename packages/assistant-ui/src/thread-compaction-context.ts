/**
 * BST-2536: a thread's Compact now, held with its conversation by
 * `ThreadCompactionProvider` (`thread-compaction.tsx`), so closing the context
 * meter's popover loses neither the words, the compaction going on nor its
 * refusal, and the composer can read that the thread is compacting.
 */
import { createContext, use } from 'react';
import type { CommittedAssistantStore } from './committed-assistant-store';

/**
 * Compacts the thread's branch that ends with `parentMessageId`, the run the
 * view ends with; rejects with the host's refusal.
 */
export type ThreadCompaction = (request: {
  readonly focus?: string;
  readonly parentMessageId: string | null;
}) => Promise<void>;

export interface ThreadCompactionValue {
  /** A compaction was asked for and has not answered: the thread takes no message. */
  readonly compacting: boolean;
  /** The host's refusal of the last compaction, as its text. */
  readonly failure: string | null;
  readonly focus: string;
  readonly setFocus: (focus: string) => void;
  /** Compacts the branch that ends with `parentMessageId`, keeping `focus`. */
  readonly start: (parentMessageId: string | null) => Promise<void>;
  /** The committed view: where it ends, whether a run is going. */
  readonly store: CommittedAssistantStore;
}

/** Absent where the thread's owner gives no compaction: nothing offers it. */
export const ThreadCompactionContext = createContext<ThreadCompactionValue | null>(null);

/** Whether the thread is compacting: the composer sends nothing until it ends. */
export function useThreadCompacting(): boolean {
  return use(ThreadCompactionContext)?.compacting ?? false;
}
