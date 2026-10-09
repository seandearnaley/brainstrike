/**
 * The resolved shape of a snapshot changeset, shared by the legacy ledger
 * resolution (`changeset-snapshot-view.ts`) and host threads' resolution from
 * the host's committed log (`changeset-host-turns.ts`). A leaf module, so
 * neither resolver imports the other.
 */
import type { GitResult } from '@brainstrike/types';
import type { SnapshotDiffTarget } from './snapshot-service';

/** One journal row's attribution identity — content fields never travel here. */
export interface SnapshotAttributionRecord {
  readonly fromPath: string | null;
  readonly path: string;
  readonly rootId: string;
}

/** The turn span an attribution join covers: first → last leg run ids. */
export interface SnapshotAttributionSpan {
  readonly firstRunId: string;
  readonly lastRunId: string;
  readonly threadId: string;
}

/**
 * Where a settled turn's tool-edit attribution comes from: the legacy
 * edit-checkpoint journal over the turn's span, or the edits a host run
 * committed to its own log.
 */
export type SnapshotTurnAttribution =
  | { readonly kind: 'journal'; readonly span: SnapshotAttributionSpan }
  | { readonly kind: 'committed'; readonly records: readonly SnapshotAttributionRecord[] };

/** One root's resolved diff endpoints. */
export interface RootDiffTarget {
  readonly fromOid: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly to: SnapshotDiffTarget;
}

export interface ResolvedTurnTargets {
  /** Null when the view is LIVE (worktree side; attribution join skipped). */
  readonly attribution: SnapshotTurnAttribution | null;
  readonly targets: readonly RootDiffTarget[];
}

export function captureFailedError(rootId: string, detail: string): GitResult<never> {
  return {
    error:
      `changeset-snapshot-capture-failed: the workspace snapshot for root "${rootId}" ` +
      `was not captured (${detail}); this changeset cannot be shown. ` +
      'Partial diffs are never fabricated.',
    ok: false,
  };
}

export function snapshotMissingError(detail: string): GitResult<never> {
  return { error: `changeset-snapshot-missing: ${detail}`, ok: false };
}
