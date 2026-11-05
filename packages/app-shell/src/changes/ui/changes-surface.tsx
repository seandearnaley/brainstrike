/**
 * `ChangesSurface` (BST-1114, W4 Task A): composition root for the Changes
 * surface. Desktop lazy-mounts this from `apps/desktop/.../changes-page-content.tsx`.
 *
 * Resolves the active workspace root the SAME way every workspace surface
 * does rather than inventing a second source of truth:
 * `rootDirectoryHandle.rootId`, falling back to the path->id map for legacy
 * single-root handles.
 *
 * THREAD/RUN IDENTITY: the assistant panel's thread store is resourceId-keyed
 * and this surface is a SIBLING top-level page, so it cannot read the "active
 * thread" directly. It does not fabricate one either. As of BST-1115 smoke
 * feedback, `AssistantUiPanelWrapper` publishes the active thread's STANDING
 * identity (`activeThreadIdentity`) into `useChangesNavigationStore` directly
 * — on thread selection and on every `run.finished`/`run.failed` — so "Last
 * Turn" works without ever requiring a "→ Review" handoff, and retargets
 * itself live while the user is on it (`selectLastTurn`/`isOnLastTurn`, see
 * the store's own doc comment). The run-range control still has no source
 * (unimplemented — see below) and stays disabled-with-reason.
 *
 * ACTIVE CHANGESET OWNERSHIP: the selection lives in
 * `useChangesNavigationStore`, not in this component. The surface stays
 * mounted for the whole session (`KeepMountedRoute` in
 * `root-layout-content.tsx`), so a component-local selection would have had to
 * be re-synced from the store on every external "→ Review" click — an effect
 * copying store state into `useState`, with all the staleness that invites.
 * Reading the store directly means the picker and the handoff write the same
 * value and this component only renders it.
 */
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import type { ChangedFileEntry, Changeset, GitInventory } from '@brainstrike/types';
import type { DiffReviewHandle } from '@brainstrike/ui';
import { type ReactElement, useMemo, useRef } from 'react';
import { useChangesNavigationStore } from '../changes-navigation-store';
import { changedFileKey } from '../changes-store';
import { useDiffCommentsToThread } from '../diff-line-comment-to-thread';
import { useChangeset } from '../use-changeset';
import { useGitInventory } from '../use-git-inventory';
import { useRootLabelById } from '../use-root-labels';
import { ChangedFilesTree } from './changed-files-tree';
import { ChangesetDiffPane } from './changeset-diff-pane';
import { ChangesetHeader } from './changeset-header';

const NO_FILES: readonly [] = [];

/**
 * Resolution root for a `git-scope` changeset: the workspace root that
 * CONTAINS its worktree, per the inventory's own `WorktreeDescriptor.containment`
 * — not the surface's single focused root. In a multi-root workspace the
 * source picker offers scopes for worktrees under EVERY mounted root, but
 * `resolveContainedWorktreeCwd` deterministically fails
 * (`outside-roots-unsupported`) unless resolution uses a root that actually
 * contains the worktree (review finding, BST-1114 PR #2274). `null` when the
 * worktree cannot be found or has no containing root — `useChangeset` stays
 * inert (no fetch) rather than guessing, which is safe: the source picker
 * already disables a scope it cannot resolve.
 */
function resolveGitScopeResolutionRootId(
  changeset: Extract<Changeset, { kind: 'git-scope' }>,
  inventory: GitInventory | null
): string | null {
  if (!inventory) {
    return null;
  }
  for (const repository of inventory.repositories) {
    if (repository.identity.repositoryRoot !== changeset.repositoryRoot) {
      continue;
    }
    for (const worktree of repository.worktrees) {
      if (worktree.path !== changeset.worktreePath) {
        continue;
      }
      return worktree.containment === 'outside-roots' ? null : (worktree.containment[0] ?? null);
    }
  }
  return null;
}

export function ChangesSurface(): ReactElement {
  const { mountedRootHandles, rootDirectoryHandle, rootIdByPath } = useFileSystem();
  const rootId = useMemo<string | null>(() => {
    if (!rootDirectoryHandle) {
      return null;
    }
    return rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path) ?? null;
  }, [rootDirectoryHandle, rootIdByPath]);

  // Every mounted root's own absolute path, keyed by its durable RootId —
  // resolves `changes.open-file`/`changes.reveal-file` for a journal-sourced
  // entry (`worktreePath: null`, real `rootId`), which has no worktree to
  // resolve an absolute path from otherwise.
  const rootPathById = useMemo<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    for (const handle of mountedRootHandles) {
      const handleRootId = handle.rootId ?? rootIdByPath?.get(handle.path) ?? null;
      if (handleRootId !== null) {
        map.set(handleRootId, handle.path);
      }
    }
    return map;
  }, [mountedRootHandles, rootIdByPath]);

  const rootLabelById = useRootLabelById();
  const sendComments = useDiffCommentsToThread(rootLabelById);
  const review = useRef<DiffReviewHandle | null>(null);
  const selectFile = (entry: ChangedFileEntry) => {
    review.current?.scrollToFile(changedFileKey(entry));
  };

  const changeset = useChangesNavigationStore((state) => state.activeChangeset);
  const requestChangeset = useChangesNavigationStore((state) => state.requestChangeset);
  const selectLastTurn = useChangesNavigationStore((state) => state.selectLastTurn);
  const activeThreadIdentity = useChangesNavigationStore((state) => state.activeThreadIdentity);

  // BST-1268 unification: WHICH thread comes from the thread store; the
  // wrapper-published identity carries only run-tracking facts. A transient
  // mismatch (identity not yet re-published after a switch) reads as "no
  // completed runs yet" rather than another thread's run.
  const threadId = useActiveAssistantThreadId();
  const latestRunId =
    activeThreadIdentity && activeThreadIdentity.threadId === threadId
      ? activeThreadIdentity.latestRunId
      : null;

  const { error: inventoryError, inventory, refresh: refreshInventory } = useGitInventory();

  // A journal changeset (`agent-run`/`run-range`) has no worktree, so it
  // resolves through the surface's own focused root as before; a
  // `git-scope` changeset resolves through its worktree's CONTAINING root
  // instead (see `resolveGitScopeResolutionRootId`'s doc comment).
  const resolutionRootId = useMemo<string | null>(() => {
    if (changeset?.kind === 'git-scope') {
      return resolveGitScopeResolutionRootId(changeset, inventory);
    }
    return rootId;
  }, [changeset, inventory, rootId]);

  const { apply, error, fileDiff, refresh, view } = useChangeset(resolutionRootId, changeset);

  const handleRetry = () => {
    void refresh();
  };

  const handleRetryInventory = () => {
    void refreshInventory();
  };

  // A stable empty tuple, not a fresh `[]` per render — both panes memoize on
  // this array's identity.
  const renderedFiles = view ? view.files : NO_FILES;

  // Structural identity of the active changeset. Both panes key per-changeset
  // state on it: the tree re-runs its first-load auto-expand, and the diff
  // keeps its folds and draft comments per changeset.
  const changesetKey = changeset === null ? '' : JSON.stringify(changeset);

  // No native `loading` field on `useChangeset` — derive it: a changeset is
  // selected, nothing has resolved yet, and there is no error to explain why.
  const loading = changeset !== null && view === null && error === null;

  return (
    <div
      className="bg-background text-foreground flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="changes-surface"
    >
      <ChangesetHeader
        changeset={changeset}
        error={error}
        inventory={inventory}
        inventoryError={inventoryError}
        latestRunId={latestRunId}
        onRetry={handleRetry}
        onRetryInventory={handleRetryInventory}
        onSelectChangeset={requestChangeset}
        onSelectLastTurn={selectLastTurn}
        rootId={rootId}
        threadId={threadId}
        view={view}
      />
      {rootId && changeset ? (
        <div className="flex min-h-0 flex-1">
          <div className="border-border flex w-72 shrink-0 flex-col border-r">
            <ChangedFilesTree
              changesetKey={changesetKey}
              files={renderedFiles}
              inventory={inventory}
              loading={loading}
              onSelectFile={selectFile}
              rootLabelById={rootLabelById}
              rootPathById={rootPathById}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <ChangesetDiffPane
              applyAction={apply}
              changesetKey={changesetKey}
              files={renderedFiles}
              loadFileDiff={fileDiff}
              onSendComments={sendComments}
              reviewRef={review}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
