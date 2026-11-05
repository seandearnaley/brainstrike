/**
 * `ChangesetDiffService` (BST-1113, W3 Task 3b; engine swap BST-1164 W7 T2):
 * resolve any `Changeset` (`agent-run` / `run-range` / `git-scope`) to a
 * `ChangesetView` eagerly, and a per-file `StructuredFileDiff` lazily — the
 * desktop-side engine behind the `changes` IPC domain.
 *
 * Dispatch is purely by `changeset.kind`:
 * - `agent-run` / `run-range` ⇒ `changeset-snapshot-view.ts` (the W7
 *   shadow-git snapshot engine: turn-boundary ref pairs over
 *   `SnapshotService.diffRefs`; a settled host run's committed tool edits
 *   supply per-file ATTRIBUTION metadata only).
 *   When the snapshot deps are not wired (a build/test constructing this
 *   service without them), these kinds resolve to a typed
 *   `snapshot-engine-unavailable:` failure — never a silent journal
 *   fallback (NO SILENT FALLBACKS).
 * - `git-scope` ⇒ `changeset-git-scope.ts` (a real git repository, via the
 *   injected `GitCommandRunner`) — UNTOUCHED by the W7 swap.
 *
 * `rootId` PLACEMENT (deliberate choice — the plan left this to the
 * implementer): `resolveView`/`fileDiff` take `rootId` as a CALL parameter,
 * not a service-level dependency, mirroring `git-methods.ts`'s
 * `withService(rootId, ...)` pattern. The service itself is a single
 * long-lived instance (constructed once, wired into the `changes` IPC
 * registrar); `rootId` names which of the desktop's potentially-many
 * workspace roots a given CALL is scoped to. `git-scope` needs it for the
 * containment check (see `changeset-git-scope.ts`); `resolveView` for
 * `agent-run`/`run-range` ignores it (a multi-root `ChangesetView`
 * legitimately mixes files from several roots in one listing). `fileDiff`
 * for `agent-run`/`run-range` DOES use it — to pick the right one of
 * possibly TWO snapshot diffs sharing the same relative path across
 * different mounted roots (MULTI-ROOT IDENTITY, BST-1113 review finding).
 *
 * `apply` stages, unstages or reverts what a `git-scope` view drew
 * (`changeset-git-actions.ts`), and reverts whole files of a settled turn
 * (`changeset-snapshot-view.ts`).
 *
 * Every failure is a visible, typed `{ ok: false, error }` whose stable
 * `changeset.*` code (never a silent fallback) is set where it is produced:
 * `changeset-snapshot-view.ts`, `changeset-snapshot-targets.ts` and
 * `changeset-git-scope.ts`.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  ChangesApplyParams,
  ChangesApplyResult,
  Changeset,
  ChangesetView,
  StructuredFileDiff,
} from '@brainstrike/types';
import { applyGitScopeAction } from './changeset-git-actions.ts';
import { resolveGitScopeChangesetView, resolveGitScopeFileDiff } from './changeset-git-scope.ts';
import type { HostThreadTurns } from './changeset-host-turns.ts';
import {
  createSnapshotChangesetResolver,
  type SnapshotChangesetResolver,
} from './changeset-snapshot-view.ts';
import { gitRefused, gitThrew } from './git-failure.ts';
import type { GitCommandRunner } from './git-service.ts';
import type { SnapshotService } from './snapshot-service.ts';

/** W7 snapshot-engine wiring (threaded from main.ts via the changes IPC options). */
interface ChangesetDiffServiceSnapshotDeps {
  /** Host threads' turns, from the host's committed log (BST-1977). */
  readonly hostThreads: HostThreadTurns;
  readonly resolveService: () => SnapshotService | null;
}

export interface ChangesetDiffServiceDeps {
  /** The audited `resolveRootCwd` seam (`workspace-root-cwd.ts`), already
   * partially applied by the caller to its `WorkspaceRootResolver`/`domain`/
   * `logger` — this service only ever supplies `rootId`. */
  readonly resolveRootCwd: (rootId: unknown) => Promise<BoundaryResult<string>>;
  readonly run: GitCommandRunner;
  /** Absent ⇒ `agent-run`/`run-range` resolve to a typed unavailability error. */
  readonly snapshots?: ChangesetDiffServiceSnapshotDeps | undefined;
}

export interface ChangesetDiffService {
  readonly apply: (params: ChangesApplyParams) => Promise<BoundaryResult<ChangesApplyResult>>;
  readonly fileDiff: (
    rootId: unknown,
    changeset: Changeset,
    path: string
  ) => Promise<BoundaryResult<StructuredFileDiff>>;
  readonly resolveView: (
    rootId: unknown,
    changeset: Changeset
  ) => Promise<BoundaryResult<ChangesetView>>;
}

const snapshotDepsUnwired = () =>
  gitRefused(
    'availability',
    'changeset.snapshot-engine-unavailable',
    'This changes service was constructed without the workspace snapshot engine, so ' +
      'agent-run/run-range changesets cannot be resolved. This is a wiring bug, not an ' +
      'empty changeset.'
  );

export function createChangesetDiffService(deps: ChangesetDiffServiceDeps): ChangesetDiffService {
  const snapshotResolver: SnapshotChangesetResolver | null = deps.snapshots
    ? createSnapshotChangesetResolver({
        hostThreads: deps.snapshots.hostThreads,
        resolveRootPath: deps.resolveRootCwd,
        resolveService: deps.snapshots.resolveService,
      })
    : null;

  return {
    apply: async (params) => {
      try {
        const { changeset } = params;
        if (changeset.kind === 'git-scope') {
          return await applyGitScopeAction(deps, { ...params, changeset });
        }
        if (!snapshotResolver) {
          return snapshotDepsUnwired();
        }
        return await snapshotResolver.apply({ ...params, changeset });
      } catch (error) {
        return gitThrew(error);
      }
    },
    fileDiff: async (rootId, changeset, path) => {
      try {
        if (changeset.kind === 'git-scope') {
          return await resolveGitScopeFileDiff(deps, rootId, changeset, path);
        }
        if (!snapshotResolver) {
          return snapshotDepsUnwired();
        }
        return await snapshotResolver.fileDiff(rootId, changeset, path);
      } catch (error) {
        return gitThrew(error);
      }
    },
    resolveView: async (rootId, changeset) => {
      try {
        if (changeset.kind === 'git-scope') {
          return await resolveGitScopeChangesetView(deps, rootId, changeset);
        }
        if (!snapshotResolver) {
          return snapshotDepsUnwired();
        }
        return await snapshotResolver.resolveView(changeset);
      } catch (error) {
        return gitThrew(error);
      }
    },
  };
}
