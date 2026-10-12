/**
 * The Worktree Map screen (spec §10, [D11]). Zero props, like `ChangesSurface`:
 * the desktop wrapper renders `<WorktreeMapSurface />` and this component
 * resolves the database, the resource, the running-thread set and the thread
 * actions from context. Every mutation it can trigger goes through a seam that
 * already exists — the checkout-intent store, the thread store, the durable
 * indexing setter, the platform bridge — so the Map owns only ephemeral collection-view state.
 */
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { WorktreeArchiveConfirmationDialog } from '@brainstrike/assistant-ui/worktree-archive-confirmation-dialog';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { Button } from '@brainstrike/ui';
import type { ReactElement } from 'react';
import { useMemo, useRef, useState } from 'react';
import { useAssistantThreadHost, withAssistantThreadHost } from '../assistant-thread-host-context';
import { resolvePlatformBridge } from '../platform-bridge';
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { isTerminalBridgeAvailable } from '../terminal-panel/terminal-bridge';
import { useActiveAssistantThreadIds } from '../use-active-assistant-thread-ids';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
import { useWorktreeMap } from './use-worktree-map';
import { useWorktreeMapCardActions } from './use-worktree-map-card-actions';
import { WorktreeMapCard } from './worktree-map-card';
import {
  selectWorktreeCollection,
  type WorktreeFilter,
  type WorktreeSort,
} from './worktree-map-collection';
import { WorktreeMapPagination, WorktreeMapToolbar } from './worktree-map-toolbar';

const EMPTY_STATE = "No worktrees yet — create one from the composer's Mode chip.";

export function WorktreeMapSurface(): ReactElement {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<WorktreeFilter>('all');
  const [sort, setSort] = useState<WorktreeSort>('name');
  const [page, setPage] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const database = usePGliteDatabase();
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const selectedThreadByResourceId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId
  );
  const selectedThreadId = selectedThreadByResourceId[resourceId];
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const selectThread = useAssistantThreadStore((state) => state.selectThread);
  const setWorktreeRootIndexingEnabled = useBackgroundIndexingPreferencesStore(
    (state) => state.setWorktreeRootIndexingEnabled
  );
  const publishIntent = useWorktreeCheckoutIntentStore((state) => state.publish);
  // Committed mode creates the thread through the host's existing thread
  // owner, exactly as the threads panel does; with no host the history
  // repository is returned unchanged.
  const host = useAssistantThreadHost();
  const repository = useMemo<AssistantThreadRepository | null>(
    () =>
      database
        ? withAssistantThreadHost(createPgliteAssistantThreadRepository(database), host)
        : null,
    [database, host]
  );
  const platform = useMemo(() => resolvePlatformBridge(), []);
  // The capability IS the gate — resolved once, not per render, exactly like
  // the platform bridge above. Web has no `window.terminal`, so no item exists.
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
  const openTerminalAt = useTerminalTargetStore((state) => state.openTerminalAt);
  const worktrees = useMemo(() => resolveWorktreesBridge(), []);
  // Desktop-only, `undefined` on web (`use-workspace-bar.ts:918` is the precedent).
  const addRootDirectoryByPath = useFileSystem().addRootDirectoryByPath;
  const { threadIds: runningThreadIds } = useActiveAssistantThreadIds({
    database,
    resourceId,
    schemaReady: Object.hasOwn(threadsByResourceId, resourceId),
  });
  const { error, loading, refresh, repositories, statusByPath } = useWorktreeMap({
    database,
    resourceId,
    runningThreadIds,
  });
  const {
    actionError,
    archiveConfirmation,
    onAddAsRoot,
    onAdopt,
    onArchive,
    onHandOffToLocal,
    onNewThread,
    onOpenTerminal,
  } = useWorktreeMapCardActions({
    addRootDirectoryByPath,
    createThread,
    openTerminalAt,
    publishIntent,
    refresh,
    repository,
    resourceId,
    selectThread,
    worktrees,
  });

  const collection = useMemo(
    () => selectWorktreeCollection({ filter, page, query, repositories, sort, statusByPath }),
    [filter, page, query, repositories, sort, statusByPath]
  );
  // Keep the source page in range too: recovering async results must not
  // restore a page the user has already been moved away from.
  if (collection.page !== page) {
    setPage(collection.page);
  }
  const changePage = (next: number): void => {
    setPage(next);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  };

  return (
    <>
      <div className="@container/worktrees flex h-full min-h-0 min-w-0 flex-col">
        <WorktreeMapToolbar
          filter={filter}
          loading={loading}
          onFilter={(value) => {
            setFilter(value);
            changePage(0);
          }}
          onQuery={(value) => {
            setQuery(value);
            changePage(0);
          }}
          onRefresh={() => {
            void refresh();
          }}
          onSort={(value) => {
            setSort(value);
            changePage(0);
          }}
          query={query}
          sort={sort}
          total={collection.total}
        />
        <div
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
          key={collection.page}
          ref={scrollRef}
        >
          {/* A stated failure, NEVER the empty state: "no worktrees" is a
          different, honest fact and must not stand in for "the read failed". */}
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          {actionError ? (
            <p className="text-destructive text-sm" role="alert">
              {actionError}
            </p>
          ) : null}
          {loading && repositories.length === 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              Loading worktrees…
            </p>
          ) : null}
          {repositories.length === 0 && !error && !loading ? (
            <p className="text-muted-foreground text-sm">{EMPTY_STATE}</p>
          ) : null}
          {collection.total > 0 && collection.matched === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <p className="font-medium text-sm">No matching worktrees</p>
              <p className="text-muted-foreground text-xs">Try another name, branch or filter.</p>
              <Button
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                  changePage(0);
                }}
                size="sm"
                variant="outline"
              >
                Clear filters
              </Button>
            </div>
          ) : null}
          {collection.repositories.map((repositoryModel) => (
            <section className="flex min-w-0 flex-col gap-2" key={repositoryModel.repoCommonDir}>
              <header className="flex min-w-0 items-center justify-between gap-3 px-1">
                <div className="min-w-0">
                  <h2 className="truncate font-medium text-sm">{repositoryModel.repositoryName}</h2>
                  <p
                    className="truncate text-[10px] text-muted-foreground"
                    title={repositoryModel.repositoryRoot}
                  >
                    {repositoryModel.repositoryRoot}
                  </p>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {repositoryModel.cards.length} shown
                </span>
              </header>
              <div
                aria-hidden="true"
                className="@min-[760px]/worktrees:grid hidden grid-cols-[minmax(0,1fr)_8.5rem_11rem_12rem] gap-3 border-l-2 border-l-transparent px-3 text-[10px] text-muted-foreground"
              >
                <span>Checkout</span>
                <span>Git status</span>
                <span>Thread</span>
                <span className="text-right">Actions</span>
              </div>
              <div
                className="overflow-hidden rounded-lg border border-border bg-card [&>article+article]:border-border [&>article+article]:border-t"
                data-testid="worktree-map-rows"
                key={`${collection.page}:${query}:${filter}:${sort}`}
              >
                {repositoryModel.cards.map((card) => (
                  <WorktreeMapCard
                    card={card}
                    key={card.entry.path}
                    onAddAsRoot={onAddAsRoot}
                    onAdopt={onAdopt}
                    onArchive={onArchive}
                    // Present only for the card holding the SELECTED thread's
                    // checkout [A11] — every other card renders no such item.
                    onHandOffToLocal={
                      card.thread && card.thread.threadId === selectedThreadId
                        ? () => onHandOffToLocal(card)
                        : undefined
                    }
                    onNewThread={onNewThread}
                    onOpenPullRequest={(url) => {
                      void platform?.openExternal(url);
                    }}
                    onOpenTerminal={terminalAvailable ? onOpenTerminal : undefined}
                    onOpenThread={(threadId) => selectThread(resourceId, threadId)}
                    onReveal={(path) => {
                      void platform?.showItemInFolder(path);
                    }}
                    onToggleIndexing={setWorktreeRootIndexingEnabled}
                    status={statusByPath.get(card.entry.path)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        <WorktreeMapPagination
          matched={collection.matched}
          onPage={changePage}
          page={collection.page}
          pageCount={collection.pageCount}
        />
      </div>
      {archiveConfirmation ? (
        <WorktreeArchiveConfirmationDialog confirmation={archiveConfirmation} />
      ) : null}
    </>
  );
}
