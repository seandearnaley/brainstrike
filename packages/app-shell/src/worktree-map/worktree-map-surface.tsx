/**
 * The Worktree Map screen (spec §10, [D11]). Zero props, like `ChangesSurface`:
 * the desktop wrapper renders `<WorktreeMapSurface />` and this component
 * resolves the database, the resource, the running-thread set and the thread
 * actions from context. Every mutation it can trigger goes through a seam that
 * already exists — the checkout-intent store, the thread store, the durable
 * indexing setter, the platform bridge — so the Map owns no state of its own.
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
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { resolvePlatformBridge } from '../platform-bridge';
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { isTerminalBridgeAvailable } from '../terminal-panel/terminal-bridge';
import { useActiveAssistantThreadIds } from '../use-active-assistant-thread-ids';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
import { useWorktreeMap } from './use-worktree-map';
import { useWorktreeMapCardActions } from './use-worktree-map-card-actions';
import { WorktreeMapCard } from './worktree-map-card';

const EMPTY_STATE = "No worktrees yet — create one from the composer's Mode chip.";

export function WorktreeMapSurface(): ReactElement {
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
  // (corrected at execution: `createThread` takes `(repository, resourceId,
  // title?)`, not a bare `resourceId` — the repository is derived from
  // `database` here exactly as `use-global-command-handlers.ts` already does
  // for the identical problem.)
  const repository = useMemo<AssistantThreadRepository | null>(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
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

  if (loading && repositories.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading worktrees…
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        {/* A stated failure, NEVER the empty state: "no worktrees" is a
          different, honest fact and must not stand in for "the read failed". */}
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        {actionError ? <p className="text-destructive text-sm">{actionError}</p> : null}
        {repositories.length === 0 && !error ? (
          <p className="text-muted-foreground text-sm">{EMPTY_STATE}</p>
        ) : null}
        {repositories.map((repositoryModel) => (
          <section className="flex min-w-0 flex-col gap-2" key={repositoryModel.repoCommonDir}>
            <h2 className="font-medium text-sm">{repositoryModel.repositoryName}</h2>
            <div className="flex gap-3 overflow-x-auto pb-2">
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
      {archiveConfirmation ? (
        <WorktreeArchiveConfirmationDialog confirmation={archiveConfirmation} />
      ) : null}
    </>
  );
}
