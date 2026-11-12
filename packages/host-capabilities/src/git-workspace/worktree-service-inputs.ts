/**
 * The worktree service's inputs (its dependencies, setup and archive
 * parameters) and its two process-local helpers, beside the service itself.
 */

import { promises as fsPromises } from 'node:fs';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeLedgerPort } from '@brainstrike/state-store';
import type {
  GitInventory,
  ManagedWorktreeRow,
  WorktreeCreateParams,
  WorktreeSettings,
  WorktreeSetupOutcome,
} from '@brainstrike/types';
import type { GitCommandRunner } from './git-service.ts';

const logger = createLogger('WorktreeService');

/**
 * A renderer-attested decision, pinned to the script's hash at decision time.
 * `resolveSetupCommand` re-hashes disk and refuses a mismatch (fail closed to
 * a visible skipped setup) rather than trusting a decision made against
 * different script contents.
 */
export interface RepositorySetupDecisionInput {
  readonly decision: 'approved' | 'denied';
  readonly scriptSha256: string;
}

/** What `runSetup` needs to run `.worktreeinclude` copy + the setup command. */
export interface WorktreeSetupInput {
  /** Test seam; production uses `WORKTREE_INCLUDE_MAX_TOTAL_BYTES`. */
  readonly copyMaxBytes?: number;
  /** Required only for the repository-committed fallback script. */
  readonly repositorySetupDecision?: RepositorySetupDecisionInput;
  readonly settings: WorktreeSettings;
  readonly sourcePath: string;
  /** Test seam; production uses `WORKTREE_SETUP_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  readonly worktree: ManagedWorktreeRow;
}

export interface WorktreeServiceDeps {
  /**
   * Told of each worktree a create recorded, before the create returns (ADR-0034 decision 7: the
   * idle-worktree cap). It starts its work and returns at once; the create never waits on it.
   */
  readonly afterCreate?: (worktree: ManagedWorktreeRow, params: WorktreeCreateParams) => void;
  readonly getWorktreeStore: () => Promise<WorktreeLedgerPort>;
  readonly hasRunningThread: (worktreeId: string) => Promise<boolean>;
  readonly readSettings: () => Promise<WorktreeSettings>;
  /**
   * The cached inventory snapshot — the same one `changes/inventory` host method
   * serves. `options.forceFresh` (threaded to `WorktreeAdoptDeps.resolveInventory`,
   * used only by `reconcileWorktreesFromShell`'s post-command read) requests a
   * build guaranteed to start after the call, main.ts's wiring maps it to
   * `GitInventoryService.getSnapshot({ maxAgeMs: 0 })`.
   */
  readonly resolveInventory: (options?: { readonly forceFresh?: boolean }) => Promise<GitInventory>;
  readonly resolveRootCwd: (rootId: string) => Promise<BoundaryResult<string>>;
  readonly resolveRootPaths: () => Promise<
    readonly { readonly id: string; readonly path: string }[]
  >;
  readonly run: GitCommandRunner;
  readonly runSetup: (input: WorktreeSetupInput) => Promise<WorktreeSetupOutcome>;
}

export interface RepositoryContext {
  readonly commonDir: string;
  readonly cwd: string;
  readonly repositoryRoot: string;
}

export interface WorktreeArchiveParams {
  readonly confirmIgnoredEntries?: string;
  readonly force?: boolean;
  /**
   * ADR-0034 decision 7: the idle-worktree cap archives, not a person. Never on the wire. The
   * archive refuses a worktree `isBound` names (asked in the archive's own turn, so a thread
   * that took it since keeps it), a locked one, one with nested repositories and one a run is
   * active in; anything else is forced, with the preview's own confirmation of ignored files.
   */
  readonly idleCap?: { readonly isBound: () => Promise<boolean> };
  readonly runId?: string;
  readonly worktreeId: string;
}

/** FIFO async mutex: tasks run strictly one at a time, failures don't wedge it. */
export function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

/**
 * Root id keyed by REALPATH'D path — the same canonical basis
 * `git-inventory-service.ts` already uses for `descriptor.path` (and, by
 * extension, for `WorktreeListEntry.path`/`row.path`, which the ledger
 * writes from that same canonical path). A root whose path no longer
 * resolves (deleted/moved since it was mounted) cannot be an exact mount for
 * anything, so it is OMITTED rather than keyed on a raw, possibly-stale
 * path — consistent with this file's "never throw across the boundary"
 * contract, this degrades that one root's exact-match lookup, never the
 * whole list.
 */
export async function buildRootIdByRealPath(
  roots: readonly { readonly id: string; readonly path: string }[]
): Promise<ReadonlyMap<string, string>> {
  const resolved = await Promise.all(
    roots.map(async (root): Promise<readonly [string, string] | null> => {
      try {
        return [await fsPromises.realpath(root.path), root.id];
      } catch (error) {
        logger.warn('worktree list: root path could not be resolved for exact-mount matching', {
          error,
          rootId: root.id,
        });
        return null;
      }
    })
  );
  return new Map(resolved.filter((entry): entry is readonly [string, string] => entry !== null));
}
