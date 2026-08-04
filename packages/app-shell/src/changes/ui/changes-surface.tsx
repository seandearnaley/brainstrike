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
 * THREAD/RUN IDENTITY (honest gap, not a fabrication): "Last Turn" needs the
 * active thread id and its most recent run id. Both are scoped inside the
 * assistant panel's own resourceId-keyed store (`assistant-thread-store.ts`),
 * which this surface — a SIBLING top-level page, not nested under the
 * assistant panel wrapper — has no reachable resourceId to read from without
 * new plumbing through `root-layout-content.tsx` (outside this task's file
 * list, same root cause as the absent "Undo turn" action in
 * `changeset-header.tsx`). Passing fabricated ids would violate NO SILENT
 * FALLBACKS, so both are `null` here; the source picker already renders
 * "Last Turn" disabled-with-reason when they are. Tracked as a follow-up.
 */
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import type { Changeset } from '@brainstrike/types';
import { type ReactElement, useMemo, useState } from 'react';
import { useChangeset } from '../use-changeset';
import { useGitInventory } from '../use-git-inventory';
// These two panes are being written concurrently by sibling W4 tasks and do
// not exist yet on disk — this surface's own `tsc`/tests intentionally never
// import this module (see the two tests' file list). The integration step
// that lands all of W4 together resolves these imports.
import { ChangedFilesTree } from './changed-files-tree';
import { ChangesetDiffPane } from './changeset-diff-pane';
import { ChangesetHeader } from './changeset-header';

/** Seeds the initial selection: "Last Turn" when a thread/run is known, else nothing selected. */
function seedChangeset(threadId: string | null, latestRunId: string | null): Changeset | null {
  if (threadId && latestRunId) {
    return { kind: 'agent-run', runId: latestRunId, threadId };
  }
  return null;
}

export function ChangesSurface(): ReactElement {
  const { rootDirectoryHandle, rootIdByPath } = useFileSystem();
  const rootId = useMemo<string | null>(() => {
    if (!rootDirectoryHandle) {
      return null;
    }
    return rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path) ?? null;
  }, [rootDirectoryHandle, rootIdByPath]);

  // See module doc comment: neither is sourced yet on this standalone page.
  const threadId: string | null = null;
  const latestRunId: string | null = null;

  const [changeset, setChangeset] = useState<Changeset | null>(() =>
    seedChangeset(threadId, latestRunId)
  );

  const { error, fileDiff, view } = useChangeset(rootId, changeset);
  const { error: inventoryError, inventory } = useGitInventory();

  const renderedFiles = view ? view.files : [];

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
        onSelectChangeset={setChangeset}
        rootId={rootId}
        threadId={threadId}
        view={view}
      />
      {rootId && changeset ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-72 shrink-0 flex-col border-border border-r">
            <ChangedFilesTree files={renderedFiles} inventory={inventory} loading={loading} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <ChangesetDiffPane
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
