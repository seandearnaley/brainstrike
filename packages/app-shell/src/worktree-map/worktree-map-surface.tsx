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
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import type { ReactElement } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { resolvePlatformBridge } from '../platform-bridge';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { openTerminalAtTarget } from '../terminal-panel/terminal-target-store';
import { useActiveAssistantThreadIds } from '../use-active-assistant-thread-ids';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
import { useWorktreeMap } from './use-worktree-map';
import { WorktreeMapCard } from './worktree-map-card';
import type { WorktreeMapCardModel } from './worktree-map-model';

const logger = createLogger('WorktreeMapSurface');

const EMPTY_STATE = "No worktrees yet — create one from the composer's Mode chip.";

/**
 * The exact refusal text `resolveGrantedRootHandle` throws
 * (`apps/desktop/src/ipc-domains/workspace-recent-roots.ts`'s
 * `NEVER_GRANTED_MESSAGE`) when neither of its two picker-less grants — an
 * exact-path recents match, or `managedWorktreeAuthorizer`'s managed-
 * directory containment + live ledger row — fires. Duplicated as a literal
 * rather than imported: errors cross the main↔renderer boundary as plain
 * strings, and `apps/desktop` is not a dependency this package can import
 * from. If that message ever changes, this match silently stops firing
 * (degrading to the generic `errorMessage` text below, never to a wrong one).
 */
const NEVER_GRANTED_MOUNT_MESSAGE =
  'Folder was never granted in this app; use Add Folder to grant it.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const [actionError, setActionError] = useState<string | null>(null);

  const onNewThread = useCallback(
    (card: WorktreeMapCardModel) => {
      const worktreeId = card.entry.id;
      if (!worktreeId) {
        // An unadopted row cannot be bound; the card is disabled in that state,
        // so reaching here at all is a wiring bug worth stating.
        setActionError(`"${card.entry.name}" is not a managed worktree yet.`);
        return;
      }
      if (!repository) {
        // Unlike the worktreeId guard above, "New thread here" is NOT
        // disabled while the database is still resolving — this is a real,
        // reachable, user-visible state (not just a wiring bug), so it gets
        // its own stated reason rather than a silent no-op.
        setActionError(
          'Starting a new thread is unavailable until the workspace database is ready.'
        );
        return;
      }
      if (!addRootDirectoryByPath) {
        // Same desktop-only seam `onAddAsRoot` already gates on below.
        setActionError('Adding a workspace root by path is unavailable in this build.');
        return;
      }
      setActionError(null);
      // Adoption (worktree-map-card-actions → Adopt) only inserts the
      // brainstrike_worktrees ledger row; it does not mount the checkout as a
      // workspace root. The intent-consumer's bind (use-workspace-bar.ts's
      // resolveRootIdAfterReconciliation) waits up to 5s for a LIVE `roots`
      // row to appear, but nothing ever creates one for a freshly-adopted
      // worktree, so the wait always exhausts (BST-1392 W5 e2e finding). The
      // OTHER two flows that bind a thread to a worktree path — creating one
      // and picking an existing one (use-worktree-mode.ts's `mountWorktree`/
      // `onSelectExisting`) — both mount first and select second; mirror that
      // ordering here rather than relying on some other reconciliation to
      // race the bind.
      void addRootDirectoryByPath(card.entry.path)
        .then((handle) => {
          if (!handle) {
            setActionError(`Could not add "${card.entry.name}" as a workspace root.`);
            return;
          }
          // Deliberately NO refresh() here (PR #2671 review): the mount
          // resolving does not mean the `roots` row exists yet — the row is
          // written later by the mid-session registration, and a refresh now
          // would race it and re-read `rootId: null`. `useWorktreeMap`
          // re-loads itself off the root-identity context once the row lands.
          return createThread(repository, resourceId).then((thread) => {
            selectThread(resourceId, thread.id);
            publishIntent({
              branch: card.entry.branch,
              path: card.entry.path,
              threadId: thread.id,
              worktreeId,
            });
          });
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not start a thread', { error: caught });
          const message = errorMessage(caught);
          // This callback only reaches `addRootDirectoryByPath` once
          // `worktreeId` is non-null (the guard above) — i.e. the worktree is
          // ALREADY adopted. So the picker-less grant's generic "never
          // granted" refusal here can only mean one known, narrow gap: the
          // worktree sits inside a granted root but outside BrainStrike's
          // managed worktrees directory, so neither of
          // `resolveGrantedRootHandle`'s two authorizations fires for it
          // (BST-1392 review). Widening that authorization surface (treating
          // any live ledger row as sufficient, regardless of managed-
          // directory containment) is a real change, ticketed separately —
          // not done here. `errorMessage` alone would surface the generic
          // "use Add Folder to grant it" copy, which is confusing right after
          // a successful Adopt; state the actual cause and the ONE remedy
          // that is verified to work: the real folder picker ("Add Folder"
          // on the workspace bar, NOT this card's "Add as root" — that item
          // calls the exact same picker-less grant and would fail the same
          // way) records an exact-path recents match, after which this
          // retries successfully.
          setActionError(
            message === NEVER_GRANTED_MOUNT_MESSAGE
              ? `"${card.entry.name}" was adopted, but it sits outside BrainStrike's managed worktrees folder, so it can't be mounted automatically. Use the workspace bar's "Add Folder" to grant this worktree's folder directly, then try "New thread here" again.`
              : message
          );
        });
    },
    [addRootDirectoryByPath, createThread, publishIntent, repository, resourceId, selectThread]
  );

  const onAddAsRoot = useCallback(
    (card: WorktreeMapCardModel) => {
      if (!addRootDirectoryByPath) {
        // The Map only registers on desktop, so a missing by-path seam is a
        // wiring bug worth stating, never a silent no-op.
        setActionError('Adding a workspace root by path is unavailable in this build.');
        return;
      }
      setActionError(null);
      addRootDirectoryByPath(card.entry.path)
        .then((handle) => {
          if (!handle) {
            setActionError(`Could not add "${card.entry.name}" as a workspace root.`);
          }
          // No refresh() on success — same racy-write reason as onNewThread's
          // mount above; the root-identity subscription re-loads the Map.
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not add a root', {
            error: caught,
            path: card.entry.path,
          });
          setActionError(errorMessage(caught));
        });
    },
    [addRootDirectoryByPath]
  );

  const onArchive = useCallback(
    (card: WorktreeMapCardModel) => {
      const worktreeId = card.entry.id;
      if (!(worktreeId && worktrees)) {
        setActionError(`"${card.entry.name}" is not a managed worktree yet.`);
        return;
      }
      setActionError(null);
      worktrees
        .archive({ worktreeId })
        .then((result) => {
          // GitResult refusal: state it verbatim (`use-worktree-mode.ts:373-374`).
          if (!result.ok) {
            setActionError(`Worktree not archived: ${result.error}`);
            return;
          }
          // Unlike the mount paths (whose `roots` write lands later, in the
          // registration effect), the archive IPC resolves only after the
          // ledger row is archived — this refresh observes a completed write,
          // mirroring onAdopt below, so the removed card leaves the list now
          // instead of on the next unrelated invalidation.
          void refresh();
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not archive', { error: caught, worktreeId });
          setActionError(errorMessage(caught));
        });
    },
    [refresh, worktrees]
  );

  // (bot review fix, PR #2664) Hand off publishes the SAME checkout-intent
  // seam as onNewThread, but with `worktreeId: null` — the null-worktree
  // branch `use-workspace-bar-mode.ts` already consumes
  // (`intent.worktreeId ? onSelectWorktree(...) : onHandOffToLocal()`), which
  // was dead until this surface actually supplied the prop. Bound to the
  // SELECTED thread's id, not the card's own thread field: the card only
  // renders this item when its `thread` IS the selected thread (see the
  // render below), so `card.thread.threadId` and `selectedThreadId` agree by
  // construction, but reading `card.thread` keeps this callback correct even
  // if a future caller wires it differently.
  const onHandOffToLocal = useCallback(
    (card: WorktreeMapCardModel) => {
      const threadId = card.thread?.threadId;
      if (!threadId) {
        // The card only renders "Hand off to Local" when it has a bound
        // thread (see the render below), so reaching here is a wiring bug
        // worth stating, never a silent no-op.
        setActionError(`"${card.entry.name}" has no thread bound to hand off.`);
        return;
      }
      setActionError(null);
      publishIntent({
        branch: card.entry.branch,
        path: card.entry.path,
        threadId,
        worktreeId: null,
      });
    },
    [publishIntent]
  );

  // The FIRST real caller of `worktrees.adopt` (Task 2 shipped the service
  // and bridge method, but the picker's own call turned out unreachable and
  // was removed — A1/A7). `WorktreeAdoptParams` takes `createdBy` + `path`
  // only, never `branch` — match that real shipped shape, not a guess at it.
  const onAdopt = useCallback(
    (card: WorktreeMapCardModel) => {
      if (!worktrees) {
        setActionError('Adopting a worktree is unavailable in this build.');
        return;
      }
      setActionError(null);
      worktrees
        .adopt({ createdBy: 'user', path: card.entry.path })
        .then((result) => {
          // GitResult refusal: state it verbatim (`use-worktree-mode.ts:373-374`).
          if (!result.ok) {
            setActionError(`Could not adopt "${card.entry.name}": ${result.error}`);
            return;
          }
          void refresh();
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not adopt', { error: caught, path: card.entry.path });
          setActionError(errorMessage(caught));
        });
    },
    [refresh, worktrees]
  );

  if (loading && repositories.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading worktrees…
      </div>
    );
  }

  return (
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
                onOpenTerminal={(targetCard) => {
                  if (!targetCard.entry.rootId) {
                    setActionError(`"${targetCard.entry.name}" is not inside a workspace root.`);
                    return;
                  }
                  setActionError(null);
                  openTerminalAtTarget({
                    cwd: targetCard.entry.path,
                    rootId: targetCard.entry.rootId,
                  });
                }}
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
  );
}
