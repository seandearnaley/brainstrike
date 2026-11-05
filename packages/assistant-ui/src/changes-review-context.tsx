import type { ChangedFileEntry, ChangesetView, StructuredFileDiff } from '@brainstrike/types';
import { createContext, type ReactNode, use } from 'react';

/** One finished run's changes, and the workspace folder a call about them is scoped to. */
export interface RunChangesTarget {
  /** A folder the run edited; a run's changes may span more than one. */
  readonly rootId: string;
  readonly runId: string;
  readonly threadId: string;
}

export interface ChangesReviewContextValue {
  /**
   * Navigate to the Changes surface pre-filtered to one assistant run's
   * changeset. `packages/ui` cannot import `packages/app-shell` (the Changes
   * surface, its navigation store, and the tab-switch action all live
   * there), so this is a capability-injection seam — PARALLEL to
   * `RunVerdictContext` and `DebugBundleContext` — that app-shell binds once
   * it has both the changes capability and a live tab-switch action.
   */
  readonly openChangesForRun: (runId: string, threadId: string) => void;
  /** The files the run changed, with git's counts and patches; rejects with why it could not. */
  readonly readRunChanges: (target: RunChangesTarget) => Promise<ChangesetView>;
  /** One of those files with both sides, to expand its unchanged lines; rejects with why. */
  readonly readRunFile: (
    target: RunChangesTarget,
    file: ChangedFileEntry
  ) => Promise<StructuredFileDiff>;
}

/**
 * Capability-injection seam for a turn's changes in the chat (BST-1114,
 * ADR-0036), modelled on `RunVerdictContext`: a separate context rather than
 * folded into `EditCheckpointContext`, because the Changes capability
 * (the desktop Changes bridge) and the checkpoint journal gate on
 * different bridges and can be present/absent independently.
 */
const ChangesReviewContext = createContext<ChangesReviewContextValue | null>(null);

export function ChangesReviewProvider({
  value,
  children,
}: {
  value: ChangesReviewContextValue | null;
  children: ReactNode;
}) {
  return <ChangesReviewContext.Provider value={value}>{children}</ChangesReviewContext.Provider>;
}

/**
 * The Changes-review binding, or `null` when no provider supplied one (web,
 * or a desktop build without the changes bridge) — capability gating, never a
 * disabled stub.
 */
export function useChangesReviewContext(): ChangesReviewContextValue | null {
  return use(ChangesReviewContext);
}
