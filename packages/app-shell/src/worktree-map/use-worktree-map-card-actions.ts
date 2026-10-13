/**
 * Card actions for the Worktree Map. The surface resolves every dependency
 * from context and passes those seams here; this hook owns only the action
 * callbacks and their stated, user-visible error.
 */
import type {
  AssistantMemoryThread,
  AssistantThreadCatalogRepository,
} from '@brainstrike/assistant-data';
import type { WorktreeArchiveConfirmation } from '@brainstrike/assistant-ui/worktree-archive-confirmation-dialog';
import type { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useState } from 'react';
import type { TerminalTargetState } from '../stores/terminal-target-store';
import type { WorktreeCheckoutIntentState } from '../stores/worktree-checkout-intent-store';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';
import type { WorktreeMapCardModel } from './worktree-map-model';

const logger = createLogger('WorktreeMapSurface');

/**
 * The exact refusal text `resolveGrantedRootHandle` throws
 * (`apps/desktop/src/ipc-domains/workspace-recent-roots.ts`'s
 * `NEVER_GRANTED_MESSAGE`) when neither of its two picker-less grants — an
 * exact-path recents match, or `managedWorktreeAuthorizer`'s live-ledger-row
 * + reachable-checkout rule (under the managed directory, or inside a
 * granted root) — fires. Duplicated as a literal
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

export interface UseWorktreeMapCardActionsInput {
  readonly addRootDirectoryByPath: ReturnType<typeof useFileSystem>['addRootDirectoryByPath'];
  readonly createThread: (
    repository: AssistantThreadCatalogRepository,
    resourceId: string,
    title?: string
  ) => Promise<AssistantMemoryThread>;
  readonly openTerminalAt: TerminalTargetState['openTerminalAt'];
  readonly publishIntent: WorktreeCheckoutIntentState['publish'];
  readonly refresh: () => Promise<void>;
  readonly repository: AssistantThreadCatalogRepository | null;
  readonly resourceId: string;
  readonly selectThread: (resourceId: string, threadId: string) => void;
  readonly worktrees: WorktreesBridge | null;
}

export interface WorktreeMapCardActions {
  readonly actionError: string | null;
  readonly archiveConfirmation: WorktreeArchiveConfirmation | null;
  readonly onAddAsRoot: (card: WorktreeMapCardModel) => void;
  readonly onAdopt: (card: WorktreeMapCardModel) => void;
  readonly onArchive: (card: WorktreeMapCardModel) => void;
  /**
   * Precondition: the caller must pass the card holding the SELECTED
   * thread's checkout — this guard only checks that `card.thread` is
   * present, not that it's the selected one. Called with a non-selected
   * card, it would still publish a well-formed hand-off intent, just for
   * the wrong thread. The enforcing gate is `worktree-map-surface.tsx`'s
   * render, which only ever wires this prop onto the card where
   * `card.thread.threadId === selectedThreadId` (hide-never-disable idiom)
   * — deliberately not re-checked here; widening this hook's input to
   * enforce identity itself is a design change outside this pure-move
   * extraction.
   */
  readonly onHandOffToLocal: (card: WorktreeMapCardModel) => void;
  readonly onNewThread: (card: WorktreeMapCardModel) => void;
  readonly onOpenTerminal: (card: WorktreeMapCardModel) => void;
}

export function useWorktreeMapCardActions(
  input: UseWorktreeMapCardActionsInput
): WorktreeMapCardActions {
  const {
    addRootDirectoryByPath,
    createThread,
    openTerminalAt,
    publishIntent,
    refresh,
    repository,
    resourceId,
    selectThread,
    worktrees,
  } = input;
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiveConfirmationState, setArchiveConfirmationState] = useState<{
    readonly card: WorktreeMapCardModel;
    readonly preview: WorktreeArchiveConfirmation['preview'] & {
      readonly confirmationToken: string;
    };
  } | null>(null);

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
          // ALREADY adopted. The picker-less grant covers every adopted
          // checkout the app can REACH — a live ledger row under the managed
          // directory OR inside a granted root (`isAuthorizedWorktreeMountPath`,
          // worktree-adopt.ts; the BST-1392 follow-up widening) — so the
          // generic "never granted" refusal here usually means the checkout is
          // outside BOTH (e.g. its granting root was disconnected after
          // adoption), but the authorizer can also refuse when it could not
          // VERIFY reachability (inventory unavailable). The copy is hedged
          // ("couldn't confirm") rather than asserting a cause the renderer
          // cannot observe (PR #2681 review). `errorMessage` alone would
          // surface the generic "use Add Folder to grant it" copy, which is
          // confusing right after a successful Adopt; state the likely cause
          // and the ONE remedy that is verified to work: the real folder
          // picker ("Add Folder" on the workspace bar, NOT this card's "Add
          // as root" — that item calls the exact same picker-less grant and
          // would fail the same way) records an exact-path recents match,
          // after which this retries successfully.
          setActionError(
            message === NEVER_GRANTED_MOUNT_MESSAGE
              ? `"${card.entry.name}" was adopted, but BrainStrike couldn't confirm it's inside an open folder or its managed worktrees folder, so it can't be mounted automatically. Use the workspace bar's "Add Folder" to grant this worktree's folder directly, then try "New thread here" again.`
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

  const onOpenTerminal = useCallback(
    (card: WorktreeMapCardModel) => {
      const { name, path, rootId } = card.entry;
      if (!rootId) {
        // The card renders this item only when `rootId` is non-null, so
        // reaching here is a wiring bug worth stating, never a silent no-op.
        setActionError(`"${name}" is not inside an open folder, so it has no terminal to open.`);
        return;
      }
      setActionError(null);
      openTerminalAt({ cwd: path, rootId });
    },
    [openTerminalAt]
  );

  const archiveCard = useCallback(
    (card: WorktreeMapCardModel, confirmIgnoredEntries?: string): void => {
      const worktreeId = card.entry.id;
      if (!(worktreeId && worktrees)) {
        setActionError(`"${card.entry.name}" is not a managed worktree yet.`);
        return;
      }
      worktrees
        .archive({ ...(confirmIgnoredEntries ? { confirmIgnoredEntries } : {}), worktreeId })
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

  const onArchive = useCallback(
    (card: WorktreeMapCardModel) => {
      const worktreeId = card.entry.id;
      if (!(worktreeId && worktrees)) {
        setActionError(`"${card.entry.name}" is not a managed worktree yet.`);
        return;
      }
      setActionError(null);
      worktrees
        .inspectArchive({ worktreeId })
        .then((result) => {
          if (!result.ok) {
            setActionError(`Could not inspect worktree for archive: ${result.error}`);
            return;
          }
          if (result.value.ignoredEntryCount === 0) {
            archiveCard(card);
            return;
          }
          if (result.value.confirmationToken === null) {
            setActionError(
              'Archive inspection did not provide an ignored-file confirmation token.'
            );
            return;
          }
          setArchiveConfirmationState({
            card,
            preview: {
              ...result.value,
              confirmationToken: result.value.confirmationToken,
            },
          });
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not inspect archive', { error: caught, worktreeId });
          setActionError(errorMessage(caught));
        });
    },
    [archiveCard, worktrees]
  );

  const archiveConfirmation: WorktreeArchiveConfirmation | null = archiveConfirmationState
    ? {
        onCancel: () => setArchiveConfirmationState(null),
        onConfirm: () => {
          const confirmation = archiveConfirmationState;
          setArchiveConfirmationState(null);
          archiveCard(confirmation.card, confirmation.preview.confirmationToken);
        },
        preview: archiveConfirmationState.preview,
        worktreeName: archiveConfirmationState.card.entry.name,
      }
    : null;

  // (bot review fix, PR #2664) Hand off publishes the SAME checkout-intent
  // seam as onNewThread, but with `worktreeId: null` — the null-worktree
  // branch `use-workspace-bar-mode.ts` already consumes
  // (`intent.worktreeId ? onSelectWorktree(...) : onHandOffToLocal()`), which
  // was dead until this surface actually supplied the prop. Bound to the
  // SELECTED thread's id, not the card's own thread field: the card only
  // renders this item when its `thread` IS the selected thread (see the
  // render in worktree-map-surface.tsx, `onHandOffToLocal` prop), so
  // `card.thread.threadId` and `selectedThreadId` agree by construction, but
  // reading `card.thread` keeps this callback correct even if a future
  // caller wires it differently.
  const onHandOffToLocal = useCallback(
    (card: WorktreeMapCardModel) => {
      const threadId = card.thread?.threadId;
      if (!threadId) {
        // The card only renders "Hand off to Local" when it has a bound
        // thread (see the render in worktree-map-surface.tsx, `onHandOffToLocal`
        // prop), so reaching here is a wiring bug worth stating, never a
        // silent no-op.
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

  return {
    actionError,
    archiveConfirmation,
    onAddAsRoot,
    onAdopt,
    onArchive,
    onHandOffToLocal,
    onNewThread,
    onOpenTerminal,
  };
}
