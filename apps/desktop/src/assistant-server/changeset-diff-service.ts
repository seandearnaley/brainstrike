/**
 * `ChangesetDiffService` (BST-1113, W3 Task 3b; engine swap BST-1164 W7 T2):
 * resolve any `Changeset` (`agent-run` / `run-range` / `git-scope`) to a
 * `ChangesetView` eagerly, and a per-file `StructuredFileDiff` lazily — the
 * desktop-side engine behind the `changes` IPC domain.
 *
 * Dispatch is purely by `changeset.kind`:
 * - `agent-run` / `run-range` ⇒ `changeset-snapshot-view.ts` (the W7
 *   shadow-git snapshot engine: turn-boundary ref pairs over
 *   `SnapshotService.diffRefs`; the edit-checkpoint journal is joined for
 *   per-file ATTRIBUTION metadata only). The former journal fold
 *   (`changeset-journal-view.ts`) is NO LONGER REACHABLE from this dispatch
 *   — the module remains only for the rewind engine until T4 retires it.
 *   When the snapshot deps are not wired (a build/test constructing this
 *   service without them), these kinds resolve to a typed
 *   `snapshot-engine-unavailable:` failure — never a silent journal
 *   fallback (NO SILENT FALLBACKS).
 * - `git-scope` ⇒ `changeset-git-scope.ts` (a real git repository, via the
 *   injected `GitCommandRunner`) — UNTOUCHED by the W7 swap.
 *
 * `rootId` PLACEMENT (deliberate choice — the plan left this to the
 * implementer): `resolveView`/`fileDiff` take `rootId` as a CALL parameter,
 * not a service-level dependency, mirroring `git-ipc-handlers.ts`'s
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
 * Every failure is a visible, typed `{ ok: false, error }` with a stable
 * machine-readable prefix (never a silent fallback) — the authoritative
 * registry:
 * `changeset-snapshot-view.ts`: `snapshot-engine-unavailable:`,
 * `changeset-snapshot-missing:`, `changeset-snapshot-capture-failed:`.
 * `changeset-git-scope.ts`: `outside-roots-unsupported:`, `base-ref-unresolved:`,
 * `head-unborn:`, `commit-id-unresolved:`, `unmerged-path:`.
 * `edit-checkpoint-journal.ts` (reused verbatim, not redefined here):
 * `run-anchor-missing:`. (`runs-unavailable:` was retired by BST-1651 with
 * the relation probes that produced it — migrations 117/118 own those
 * relations, so an absent one is an unmigrated database, not a state this
 * dispatch can describe.)
 * (`journal-content-expired:` / `journal-path-collision:` are no longer
 * producible from this dispatch; they die with the journal fold in T4.)
 */
import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
import type { RootCwdResult } from '../workspace-root-cwd';
import { resolveGitScopeChangesetView, resolveGitScopeFileDiff } from './changeset-git-scope';
import type { HostThreadTurns } from './changeset-host-turns';
import {
  createSnapshotChangesetResolver,
  type SnapshotChangesetResolver,
} from './changeset-snapshot-view';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import { type GitCommandRunner, toErrorMessage } from './git-service';
import type { SnapshotRepository } from './snapshot-repository';
import type { SnapshotService } from './snapshot-service';
import type { SnapshotTurnRegistry } from './snapshot-turn-registry';

/** W7 snapshot-engine wiring (threaded from main.ts via the changes IPC options). */
export interface ChangesetDiffServiceSnapshotDeps {
  readonly createRepository: (db: EditCheckpointDatabase) => SnapshotRepository;
  /** Host threads' turns, from the host's committed log (BST-1977). */
  readonly hostThreads?: HostThreadTurns | undefined;
  /** Injectable for tests; defaults to the process-shared registry. */
  readonly registry?: SnapshotTurnRegistry | undefined;
  readonly resolveService: () => SnapshotService | null;
}

export interface ChangesetDiffServiceDeps {
  readonly resolveDatabase: () => Promise<EditCheckpointDatabase>;
  /** The audited `resolveRootCwd` seam (`workspace-root-cwd.ts`), already
   * partially applied by the caller to its `WorkspaceRootResolver`/`domain`/
   * `logger` — this service only ever supplies `rootId`. */
  readonly resolveRootCwd: (rootId: unknown) => Promise<RootCwdResult>;
  readonly run: GitCommandRunner;
  /** Absent ⇒ `agent-run`/`run-range` resolve to a typed unavailability error. */
  readonly snapshots?: ChangesetDiffServiceSnapshotDeps | undefined;
}

export interface ChangesetDiffService {
  readonly fileDiff: (
    rootId: unknown,
    changeset: Changeset,
    path: string
  ) => Promise<GitResult<StructuredFileDiff>>;
  readonly resolveView: (
    rootId: unknown,
    changeset: Changeset
  ) => Promise<GitResult<ChangesetView>>;
}

const SNAPSHOT_DEPS_UNWIRED_ERROR =
  'snapshot-engine-unavailable: this changes service was constructed without the workspace ' +
  'snapshot engine, so agent-run/run-range changesets cannot be resolved. This is a wiring ' +
  'bug, not an empty changeset.';

export function createChangesetDiffService(deps: ChangesetDiffServiceDeps): ChangesetDiffService {
  const snapshotResolver: SnapshotChangesetResolver | null = deps.snapshots
    ? createSnapshotChangesetResolver({
        createRepository: deps.snapshots.createRepository,
        hostThreads: deps.snapshots.hostThreads,
        registry: deps.snapshots.registry,
        resolveDatabase: deps.resolveDatabase,
        resolveService: deps.snapshots.resolveService,
      })
    : null;

  return {
    fileDiff: async (rootId, changeset, path) => {
      try {
        if (changeset.kind === 'git-scope') {
          return await resolveGitScopeFileDiff(deps, rootId, changeset, path);
        }
        if (!snapshotResolver) {
          return { error: SNAPSHOT_DEPS_UNWIRED_ERROR, ok: false };
        }
        return await snapshotResolver.fileDiff(rootId, changeset, path);
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
    resolveView: async (rootId, changeset) => {
      try {
        if (changeset.kind === 'git-scope') {
          return await resolveGitScopeChangesetView(deps, rootId, changeset);
        }
        if (!snapshotResolver) {
          return { error: SNAPSHOT_DEPS_UNWIRED_ERROR, ok: false };
        }
        return await snapshotResolver.resolveView(changeset);
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
