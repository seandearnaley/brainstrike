/**
 * `ChangesSurface` (BST-1114, W4 Task A): composition root for the Changes
 * surface. Desktop lazy-mounts this from `apps/desktop/.../changes-page-content.tsx`,
 * mirroring `git-page-content.tsx` -> `GitPanel`.
 *
 * Resolves the active workspace root the SAME way the Git panel does
 * (`use-git-panel.ts`'s `activeRootId` derivation) rather than inventing a
 * second source of truth: `rootDirectoryHandle.rootId`, falling back to the
 * path->id map for legacy single-root handles.
 *
 * THREAD/RUN IDENTITY: the assistant panel's thread store is resourceId-keyed
 * and this surface is a SIBLING top-level page, so it cannot read the "active
 * thread" directly. It does not fabricate one either. Instead the identity
 * arrives with the navigation handoff: the assistant turn footer's "→ Review"
 * link publishes a real `agent-run` changeset through
 * `useChangesNavigationStore`, and both ids are taken FROM that changeset.
 * Until a handoff has happened the picker renders "Last Turn" and the
 * run-range control disabled-with-reason, which is the honest state — see the
 * PR's tracked follow-up for sourcing the active thread without a handoff.
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
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react';
import { useChangesNavigationStore } from '../changes-navigation-store';
import { useChangesStore } from '../changes-store';
import { useChangeset } from '../use-changeset';
import { useGitInventory } from '../use-git-inventory';
import { ChangedFilesTree } from './changed-files-tree';
import { ChangesetDiffPane } from './changeset-diff-pane';
import { ChangesetHeader } from './changeset-header';

const NO_FILES: readonly [] = [];

export function ChangesSurface(): ReactElement {
  const { rootDirectoryHandle, rootIdByPath } = useFileSystem();
  const rootId = useMemo<string | null>(() => {
    if (!rootDirectoryHandle) {
      return null;
    }
    return rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path) ?? null;
  }, [rootDirectoryHandle, rootIdByPath]);

  const changeset = useChangesNavigationStore((state) => state.activeChangeset);
  const requestChangeset = useChangesNavigationStore((state) => state.requestChangeset);
  const handoffThreadIdentity = useChangesNavigationStore((state) => state.handoffThreadIdentity);
  const clearSelection = useChangesStore((state) => state.clearSelection);

  const threadId = handoffThreadIdentity?.threadId ?? null;
  const latestRunId = handoffThreadIdentity?.latestRunId ?? null;

  const { error, fileDiff, refresh, view } = useChangeset(rootId, changeset);
  const { error: inventoryError, inventory } = useGitInventory();

  const handleRetry = useCallback(() => {
    void refresh();
  }, [refresh]);

  // A stable empty tuple, not a fresh `[]` per render — both panes memoize on
  // this array's identity.
  const renderedFiles = view ? view.files : NO_FILES;

  // Structural identity of the active changeset. Both panes key per-changeset
  // state on it: the tree re-runs its first-load auto-expand, and the diff
  // pane remounts its cards so a file present in BOTH changesets cannot keep
  // showing the diff it loaded for the previous one.
  const changesetKey = changeset === null ? '' : JSON.stringify(changeset);

  // Dropping the previous changeset's file selection is NOT optional:
  // `selectedFileKeys` carries no changeset identity, so a selection carried
  // over from the previous changeset can match nothing in the new one and
  // filter every file out of the diff pane — over a tree of visibly unchecked
  // boxes. Keyed on the changeset, and skipped on the very first run so an
  // externally-requested changeset does not have its selection cleared twice.
  const clearedForChangesetRef = useRef<string | null>(null);
  useEffect(() => {
    if (clearedForChangesetRef.current === changesetKey) {
      return;
    }
    clearedForChangesetRef.current = changesetKey;
    clearSelection();
  }, [changesetKey, clearSelection]);

  // No native `loading` field on `useChangeset` — derive it: a changeset is
  // selected, nothing has resolved yet, and there is no error to explain why.
  const loading = changeset !== null && view === null && error === null;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-testid="changes-surface"
    >
      <ChangesetHeader
        changeset={changeset}
        error={error}
        inventory={inventory}
        inventoryError={inventoryError}
        latestRunId={latestRunId}
        loading={loading}
        onRetry={handleRetry}
        onSelectChangeset={requestChangeset}
        rootId={rootId}
        threadId={threadId}
        view={view}
      />
      {rootId && changeset ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-72 shrink-0 flex-col border-border border-r">
            <ChangedFilesTree
              changesetKey={changesetKey}
              files={renderedFiles}
              inventory={inventory}
              loading={loading}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <ChangesetDiffPane
              changesetKey={changesetKey}
              changesetKind={changeset.kind}
              files={renderedFiles}
              loadFileDiff={fileDiff}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
