/**
 * The resolved shape of a snapshot changeset, shared by the legacy ledger
 * resolution (`changeset-snapshot-view.ts`) and host threads' resolution from
 * the host's committed log (`changeset-host-turns.ts`). A leaf module, so
 * neither resolver imports the other.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { gitRefused } from './git-failure.ts';
import type { SnapshotDiffTarget } from './snapshot-service.ts';

/** One committed tool edit's root-relative identity — content never travels here. */
export interface SnapshotAttributionRecord {
  readonly fromPath: string | null;
  readonly path: string;
  readonly rootId: string;
}

/** One root's resolved diff endpoints. */
export interface RootDiffTarget {
  readonly fromOid: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly to: SnapshotDiffTarget;
}

export interface ResolvedTurnTargets {
  /**
   * The tool edits a settled host run committed to its own log. Null when the
   * view is LIVE (worktree side) or the turn has no attribution source (a
   * legacy ledger turn), so its files carry no `toolAttributed`.
   */
  readonly attribution: readonly SnapshotAttributionRecord[] | null;
  readonly targets: readonly RootDiffTarget[];
}

export function captureFailedError(rootId: string, detail: string): BoundaryResult<never> {
  return gitRefused(
    'availability',
    'changeset.snapshot-capture-failed',
    `The workspace snapshot for root "${rootId}" was not captured (${detail}); ` +
      'this changeset cannot be shown. Partial diffs are never fabricated.'
  );
}

export function snapshotMissingError(detail: string): BoundaryResult<never> {
  return gitRefused('availability', 'changeset.snapshot-missing', detail);
}
