import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import type { WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { persistDurable } from '@brainstrike/storage';
import { Schema } from 'effect';
import { create } from 'zustand';

/**
 * BST-2281: a thread's workspace hydration that a document unload interrupted. The unload joins
 * writes, never reads (ADR-0026 R1), so an edit made while the hydration's read was pending has
 * no write to carry it; the live stores keep it, but the next document would apply the stored
 * row over them. The unload records the hydration's baseline instead, and the next document's
 * first hydration of that thread resumes from it, so its merge still sees the edit as an edit.
 */
export interface InterruptedHydration {
  /** The workspace when the interrupted hydration's read started. */
  readonly snapshot: WorkspaceSnapshotV1;
  readonly threadId: string;
}

interface InterruptedHydrationState {
  readonly interrupted: InterruptedHydration | null;
  /** Written synchronously, so an unload has nothing left to join. */
  record(hydration: InterruptedHydration): void;
  /** Forgets `threadId`'s record once a hydration has resumed it. */
  resolve(threadId: string): void;
}

const STORE_NAME = 'brainstrike:thread-workspace-interrupted-hydration.v1' as const;
const logger = createLogger('InterruptedHydrationStore');
const isSnapshot = Schema.is(WorkspaceSnapshotSchema);

/** A saved record that is not a whole snapshot is dropped: resuming from it would merge garbage. */
function coerce(persisted: unknown): InterruptedHydration | null {
  const interrupted =
    persisted && typeof persisted === 'object' && 'interrupted' in persisted
      ? persisted.interrupted
      : null;
  if (interrupted === null) {
    return null;
  }
  if (
    interrupted &&
    typeof interrupted === 'object' &&
    'threadId' in interrupted &&
    typeof interrupted.threadId === 'string' &&
    'snapshot' in interrupted &&
    isSnapshot(interrupted.snapshot)
  ) {
    // The schema spells an absent optional field `undefined`; the interface omits it.
    return {
      snapshot: interrupted.snapshot as WorkspaceSnapshotV1,
      threadId: interrupted.threadId,
    };
  }
  logger.warn('The saved interrupted workspace hydration is not readable; it is dropped');
  return null;
}

export const useInterruptedHydrationStore = create<InterruptedHydrationState>()(
  persistDurable(
    STORE_NAME,
    (set) => ({
      interrupted: null,
      record: (interrupted) => set({ interrupted }),
      resolve: (threadId) =>
        set((state) => (state.interrupted?.threadId === threadId ? { interrupted: null } : state)),
    }),
    {
      merge: (persisted, current) => ({ ...current, interrupted: coerce(persisted) }),
      partialize: (state) => ({ interrupted: state.interrupted }),
      version: 1,
    }
  )
);
