/**
 * `ChangesetDiffService` (BST-1113, W3 Task 3b): resolve any `Changeset`
 * (`agent-run` / `run-range` / `git-scope`) to a `ChangesetView` eagerly, and
 * a per-file `StructuredFileDiff` lazily — the desktop-side engine behind the
 * `changes` IPC domain (wired by Task 4).
 *
 * Dispatch is purely by `changeset.kind`:
 * - `agent-run` / `run-range` ⇒ `changeset-journal-view.ts` (the edit
 *   checkpoint journal — READ-ONLY, git-independent).
 * - `git-scope` ⇒ `changeset-git-scope.ts` (a real git repository, via the
 *   injected `GitCommandRunner`).
 *
 * `rootId` PLACEMENT (deliberate choice — the plan left this to the
 * implementer): `resolveView`/`fileDiff` take `rootId` as a CALL parameter,
 * not a service-level dependency, mirroring `git-ipc-handlers.ts`'s
 * `withService(rootId, ...)` pattern. The service itself is a single
 * long-lived instance (constructed once, wired into the `changes` IPC
 * registrar); `rootId` names which of the desktop's potentially-many
 * workspace roots a given CALL is scoped to, and only `git-scope` changesets
 * need it at all (for the containment check — see `changeset-git-scope.ts`).
 * `agent-run`/`run-range` calls ignore it entirely: journal entries carry
 * their OWN `rootId` per record, which is what journal `fileDiff` actually
 * resolves against — see `changeset-journal-view.ts`'s doc comment.
 *
 * Every failure is a visible, typed `{ ok: false, error }` with a stable
 * machine-readable prefix (never a silent fallback) — see each sibling
 * module's doc comment for the prefixes it defines:
 * `changeset-journal-view.ts`: `journal-content-expired:`,
 * `journal-path-collision:`.
 * `changeset-git-scope.ts`: `outside-roots-unsupported:`, `base-ref-unresolved:`,
 * `head-unborn:`, `commit-id-unresolved:`, `unmerged-path:`.
 * `edit-checkpoint-journal.ts` (reused verbatim, not redefined here):
 * `runs-unavailable:`, `run-anchor-missing:`.
 */
import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
import type { RootCwdResult } from '../workspace-root-cwd';
import { resolveGitScopeChangesetView, resolveGitScopeFileDiff } from './changeset-git-scope';
import { resolveJournalChangesetView, resolveJournalFileDiff } from './changeset-journal-view';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import { type GitCommandRunner, toErrorMessage } from './git-service';

export interface ChangesetDiffServiceDeps {
  readonly resolveDatabase: () => Promise<EditCheckpointDatabase>;
  /** The audited `resolveRootCwd` seam (`workspace-root-cwd.ts`), already
   * partially applied by the caller to its `WorkspaceRootResolver`/`domain`/
   * `logger` — this service only ever supplies `rootId`. */
  readonly resolveRootCwd: (rootId: unknown) => Promise<RootCwdResult>;
  readonly run: GitCommandRunner;
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

export function createChangesetDiffService(deps: ChangesetDiffServiceDeps): ChangesetDiffService {
  return {
    fileDiff: async (rootId, changeset, path) => {
      try {
        if (changeset.kind === 'git-scope') {
          return await resolveGitScopeFileDiff(deps, rootId, changeset, path);
        }
        const db = await deps.resolveDatabase();
        return await resolveJournalFileDiff(
          { db, resolveRootCwd: deps.resolveRootCwd },
          changeset,
          path
        );
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
    resolveView: async (rootId, changeset) => {
      try {
        if (changeset.kind === 'git-scope') {
          return await resolveGitScopeChangesetView(deps, rootId, changeset);
        }
        const db = await deps.resolveDatabase();
        return await resolveJournalChangesetView(db, changeset);
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
