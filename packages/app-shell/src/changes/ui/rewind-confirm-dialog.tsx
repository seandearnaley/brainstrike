/**
 * The Conversation Rewind confirm modal (BST-1115, W5 T4) — the ONE place a
 * rewind can be applied, reached from the assistant panel's "Restore to before
 * this message" and from the Changes header's "Restore to before this".
 *
 * FOUR RULES THIS COMPONENT EXISTS TO HOLD:
 *
 * 1. THE SCOPE CHOICE IS VISIBLE (Amendment 1 A1.1). `conversation-and-files`
 *    is pre-selected, not hidden: the user can see and change it before
 *    anything is applied.
 * 2. THE ACKNOWLEDGMENT GATE. In files mode, ANY conflict blocks the whole
 *    apply — Confirm stays disabled until every named path has been shown and
 *    the box ticked. `conversation-only` never reaches disk, so the gate does
 *    not apply to it and the conflict block is not shown.
 * 3. THE PREVIEW IS THE EXISTING RUN-RANGE CHANGESET VIEW. Tree and diffs are
 *    W4's own `ChangedFilesTree`/`ChangesetDiffPane`, fed by the preview the
 *    main process resolved — not a second computation that could disagree with
 *    the Review panel.
 * 4. NOTHING IS SYNCED FROM PROPS INTO STATE. A new request REMOUNTS the body
 *    via `key`, which is how the mode/acknowledgment reset — React Doctor's
 *    `no-adjust-state-on-prop-change`, the defect W4's navigation store exists
 *    to avoid. An acknowledgment must never survive into a different rewind.
 */
import type { AssistantRewindMode } from '@brainstrike/assistant-contract';
// Deep subpath, not the `assistant-ui-panel` barrel: that barrel pulls the
// whole assistant panel (and `@assistant-ui/react`) into the Changes chunk.
import { useRewindComposerStore } from '@brainstrike/assistant-ui/rewind-composer-store';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ToastAction,
  useToast,
} from '@brainstrike/ui';
import { Loader2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type {
  RewindConflictModel,
  RewindConversationEffect,
  RewindOutcomeModel,
  RewindPreviewModel,
  RewindUndo,
} from '../rewind-port';
import { type RewindRequest, useRewindStore } from '../rewind-store';
import { useGitInventory } from '../use-git-inventory';
import { type UseRewindResult, useRewind } from '../use-rewind';
import { useRewindExplorerRecovery } from '../use-rewind-explorer-recovery';
import { useRootLabelById } from '../use-root-labels';
import { ChangedFilesTree } from './changed-files-tree';
import { ChangesetDiffPane } from './changeset-diff-pane';
import { RewindConflictList } from './rewind-conflict-list';
import { RewindOutcomeSummary, rewindConversationOutcome } from './rewind-outcome-summary';
import { DEFAULT_REWIND_MODE, RewindScopeChoice } from './rewind-scope-choice';

/**
 * Amendment 1 A1.2, verbatim. Reverted files are written through the SAME
 * `writeFile` seam the agent's own edits use, so the existing `fs:watch`
 * pipeline reports them exactly as it reports an agent edit — no new refresh
 * path is needed. What the pipeline cannot do is reconcile an unsaved external
 * editor buffer, hence the second clause. Deeper open-file handling is a
 * tracked follow-up, not W5 scope.
 */
const OPEN_FILES_NOTICE = 'Open files will be updated on disk; unsaved external edits may conflict';

const NO_FILES: readonly [] = [];

const UNDO_WINDOW = 'Undo is available until you send your next message.';

/**
 * What applying would do to the later messages, in the owner's own terms; the
 * count joins once the preview has resolved it.
 */
function rewindConversationPreview(
  kind: RewindConversationEffect['kind'],
  effect: RewindConversationEffect | null
): string {
  if (kind === 'hidden') {
    const count = effect?.kind === 'hidden' ? ` ${effect.messages} message(s) affected.` : '';
    return `This message and everything after it will be hidden.${count}`;
  }
  const count =
    effect?.kind === 'branched'
      ? ` ${effect.turns === 1 ? '1 turn leaves' : `${effect.turns} turns leave`} this conversation; switch back to ${effect.turns === 1 ? 'it' : 'them'} with the branch picker.`
      : '';
  return `The conversation returns to before this message.${count}`;
}

/** Which conflicts the gate is currently about: the apply's, else the preview's. */
function activeConflicts(
  preview: RewindPreviewModel | null,
  applyConflicts: readonly RewindConflictModel[] | null
): readonly RewindConflictModel[] {
  if (applyConflicts !== null) {
    return applyConflicts;
  }
  return preview?.ok === true ? preview.conflicts : [];
}

function RewindPreviewPanes({
  rewind,
  requestKey,
}: {
  readonly requestKey: string;
  readonly rewind: UseRewindResult;
}): ReactElement | null {
  const { inventory } = useGitInventory();
  const rootLabelById = useRootLabelById();
  const preview = rewind.preview;
  if (preview?.ok !== true || !preview.changeset) {
    return null;
  }
  const files = preview.view ? preview.view.files : NO_FILES;
  return (
    <div className="flex min-h-56 flex-1 overflow-hidden rounded-md border border-border">
      <div className="flex w-64 shrink-0 flex-col border-border border-r">
        <ChangedFilesTree
          changesetKey={requestKey}
          files={files}
          inventory={inventory}
          loading={rewind.loading}
          rootLabelById={rootLabelById}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <ChangesetDiffPane
          changesetKey={requestKey}
          changesetKind={preview.changeset.kind}
          files={files}
          loadFileDiff={rewind.fileDiff}
        />
      </div>
    </div>
  );
}

interface AppliedState {
  readonly mode: AssistantRewindMode;
  readonly outcome: RewindOutcomeModel;
}

/**
 * The modal body. Remounted per request (see rule 4) so `mode`,
 * `acknowledged` and every result below start clean for each rewind.
 */
function RewindConfirmBody({
  onClose,
  request,
  requestKey,
}: {
  readonly onClose: () => void;
  readonly request: RewindRequest;
  readonly requestKey: string;
}): ReactElement {
  const { toast } = useToast();
  const rewind = useRewind(request.port, request.target);
  // The Explorer cannot learn about a bulk revert from the watcher alone — see
  // `use-rewind-explorer-recovery.ts`. Fired after BOTH a files-mode apply and
  // a redo, since both are the same kind of burst against the same roots.
  const recoverExplorer = useRewindExplorerRecovery();
  const [mode, setMode] = useState<AssistantRewindMode>(DEFAULT_REWIND_MODE);
  const [acknowledged, setAcknowledged] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyConflicts, setApplyConflicts] = useState<readonly RewindConflictModel[] | null>(null);
  const [result, setResult] = useState<AppliedState | null>(null);

  const preview = rewind.preview;
  // BST-1164 W7 T3: a target whose turn has no usable workspace snapshot
  // (pre-snapshot turn, or a failed/incomplete capture) cannot offer the
  // files scope. The choice stays visible with the engine's reason under it
  // (see RewindScopeChoice), and the EFFECTIVE mode is forced to
  // conversation-only so the pre-selected files default can never send a
  // files-mode apply the engine would refuse.
  const filesScope = preview?.ok === true ? preview.filesScope : ({ available: true } as const);
  const effectiveMode: AssistantRewindMode =
    filesScope.available === false ? 'conversation-only' : mode;
  const filesMode = effectiveMode === 'conversation-and-files';
  const conflicts = activeConflicts(preview, applyConflicts);
  // `conversation-only` touches no disk, so the gate genuinely does not apply
  // to it — this is not a bypass, it is the mode having nothing to conflict on.
  const gateBlocks = filesMode && conflicts.length > 0 && !acknowledged;

  // `acknowledgeConflicts` defaults false: the FIRST attempt must always be an
  // honest pre-scan, never a blind force. Only the toast's own retry action
  // (raised below, in response to THIS call's own `conflicts-unacknowledged`
  // refusal) ever passes `true` — the acknowledgment is for the paths this
  // specific redo just named, never a standing override.
  const onRedo = async (
    undo: RewindUndo,
    threadId: string,
    acknowledgeConflicts = false
  ): Promise<void> => {
    const redone = await rewind.redo({ ...undo, acknowledgeConflicts, threadId });
    if (!redone.ok) {
      toast({
        description: redone.error,
        title: 'Could not undo the rewind',
        variant: 'destructive',
      });
      return;
    }
    if (!redone.value.ok) {
      // A conflicted redo is not a dead end: the SAME conflicting paths named
      // in `redone.value.message` can be forced from this toast, mirroring
      // the confirm modal's own gate — the force is scoped to exactly what
      // THIS refusal reported, never a blanket retry.
      if (redone.value.forceable) {
        // Persistent for the same reason as the redo toast it replaced:
        // clicking "Undo rewind" consumed that toast, so THIS one is now the
        // only affordance left for completing the redo — a 5s default would
        // strand it exactly the same way (see use-toast.ts DURATION
        // SEMANTICS).
        toast({
          action: (
            <ToastAction
              altText="Undo anyway, overwriting the listed files"
              data-testid="rewind-redo-force-toast-action"
              onClick={() => void onRedo(undo, threadId, true)}
            >
              Undo anyway
            </ToastAction>
          ),
          description: redone.value.message,
          persistent: true,
          title: 'Could not undo the rewind',
          variant: 'destructive',
        });
        return;
      }
      toast({
        description: redone.value.message,
        title: 'Could not undo the rewind',
        variant: 'destructive',
      });
      return;
    }
    // Durable state changed again (messages un-hidden, files put back), so the
    // live thread and the Changes surface must re-read exactly as they do after
    // an apply — see `useRewindStore.generation`.
    useRewindStore.getState().markRewindApplied();
    // Same reasoning as the apply path: dispatch now, re-watch in the
    // background. A redo rewrites exactly the files the apply reverted.
    void recoverExplorer(redone.value.roots);
    toast({
      description: redone.value.description,
      title: 'Rewind undone',
    });
  };

  const announceApplied = (
    undo: RewindUndo,
    description: string,
    threadId: string,
    title = 'Conversation restored'
  ): void => {
    // `persistent: true` (NOT merely omitting `duration` — Radix's provider
    // default closes an undurationed toast after 5s, see use-toast.ts's
    // DURATION SEMANTICS): this toast is the ONLY redo affordance, and the
    // redo WINDOW stays open until the next user message finalizes the
    // rewind. A timed toast would advertise a shorter window than exists and
    // then strand redo entirely (BST-1164 CDT finding).
    toast({
      action: (
        <ToastAction
          altText="Undo this rewind"
          data-testid="rewind-undo-toast-action"
          onClick={() => void onRedo(undo, threadId)}
        >
          Undo rewind
        </ToastAction>
      ),
      description: `${description} ${UNDO_WINDOW}`,
      persistent: true,
      title,
    });
  };

  const onConfirm = async (): Promise<void> => {
    if (preview?.ok !== true) {
      return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      const outcome = await rewind.apply({
        // The flag carries ONLY what the user actually ticked, and only in the
        // mode where it means anything.
        acknowledgeConflicts: filesMode && acknowledged,
        mode: effectiveMode,
        preview,
      });
      if (!outcome.ok) {
        setApplyError(outcome.error);
        return;
      }
      if (!outcome.value.ok) {
        if (outcome.value.conflicts !== null) {
          // Disk changed between preview and apply. Show the CURRENT conflict
          // set and require a fresh acknowledgment — the old tick was for a
          // different list of paths.
          setApplyConflicts(outcome.value.conflicts);
          setAcknowledged(false);
        }
        setApplyError(outcome.value.message);
        if (outcome.value.redoable) {
          // It took effect partway: durable state changed, and it can still be undone.
          useRewindStore.getState().markRewindApplied();
          announceApplied(
            outcome.value.redoable,
            outcome.value.message,
            preview.threadId,
            'Rewind interrupted'
          );
        }
        return;
      }
      setResult({ mode: effectiveMode, outcome: outcome.value.outcome });
      // BEFORE the composer repopulation below, and before the toast: the
      // rewind is now durable, and every live surface still shows the
      // conversation and the files it just changed. See
      // `useRewindStore.generation` for why this is a counter and not a
      // `threadKey` bump.
      useRewindStore.getState().markRewindApplied();
      // NOT awaited: the refresh dispatch is synchronous (it happens before the
      // hook's first await), while the watcher retry behind it is main-process
      // throttled and can take seconds. Holding "Restoring…" open for a
      // background re-watch would report the rewind as still running when it is
      // already done. Every failure inside is logged there, never swallowed.
      const { outcome: applied, rewindId } = outcome.value;
      void recoverExplorer(applied.roots);
      announceApplied(
        { rewindId, roots: applied.roots },
        rewindConversationOutcome(applied.conversation),
        preview.threadId
      );
      if (request.composerText !== null) {
        // Amendment 2: the target prompt goes back in the composer so the user
        // can re-send a variant. `null` (assistant target, or no text) means no
        // repopulation — never a fabricated prompt.
        useRewindComposerStore.getState().requestComposerText(request.composerText);
      }
    } finally {
      setApplying(false);
    }
  };

  if (result) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Conversation restored</DialogTitle>
          <DialogDescription>
            Undo is available from the notification until you send your next message.
          </DialogDescription>
        </DialogHeader>
        <RewindOutcomeSummary outcome={result.outcome} />
        <DialogFooter>
          <Button data-testid="rewind-done" onClick={onClose} type="button">
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Restore to before this message</DialogTitle>
        <DialogDescription>
          {rewindConversationPreview(
            request.port.conversation,
            preview?.ok === true ? preview.conversation : null
          )}
        </DialogDescription>
      </DialogHeader>

      {rewind.loading ? (
        <p
          className="flex items-center gap-1.5 text-muted-foreground text-xs"
          data-testid="rewind-loading"
        >
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          Working out what this would restore…
        </p>
      ) : null}

      {rewind.error ? (
        <p className="text-destructive text-xs" data-testid="rewind-preview-error">
          {rewind.error}
        </p>
      ) : null}

      {preview && !preview.ok ? (
        <p className="text-destructive text-xs" data-testid="rewind-preview-refused">
          {preview.message}
        </p>
      ) : null}

      {preview?.ok === true && preview.noRecordedEdits ? (
        <p className="text-muted-foreground text-xs" data-testid="rewind-no-file-changes">
          No agent file edits are recorded after this message — only the conversation can be
          restored.
        </p>
      ) : null}

      <RewindPreviewPanes requestKey={requestKey} rewind={rewind} />

      <RewindScopeChoice
        conversation={request.port.conversation}
        disabled={applying}
        filesScope={filesScope}
        mode={effectiveMode}
        onModeChange={setMode}
      />

      {filesMode ? (
        <p className="text-muted-foreground text-xs" data-testid="rewind-open-files-notice">
          {OPEN_FILES_NOTICE}
        </p>
      ) : null}

      {filesMode ? (
        <RewindConflictList
          acknowledged={acknowledged}
          conflicts={conflicts}
          onAcknowledgedChange={setAcknowledged}
        />
      ) : null}

      {applyError ? (
        <p className="text-destructive text-xs" data-testid="rewind-apply-error">
          {applyError}
        </p>
      ) : null}

      <DialogFooter>
        <Button data-testid="rewind-cancel" onClick={onClose} type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          data-testid="rewind-confirm"
          disabled={applying || gateBlocks || preview?.ok !== true}
          onClick={() => void onConfirm()}
          type="button"
        >
          {applying ? 'Restoring…' : 'Restore'}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Mount once, near the app root: both entry points write the same
 * `useRewindStore` request and this renders it.
 */
export function RewindConfirmDialog(): ReactElement {
  const request = useRewindStore((state) => state.request);
  const closeRewind = useRewindStore((state) => state.closeRewind);

  // `Dialog` stays mounted and CLOSES through its own `open` prop rather than
  // being yanked out of the tree when the request clears. Radix's scroll lock
  // drops `pointer-events` on everything behind the panel and restores it on
  // the close transition; unmounting the whole dialog instead skips that
  // restore and leaves the page — including the redo toast this modal just
  // raised — permanently unclickable.
  const requestKey = request === null ? '' : JSON.stringify(request.target);

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : closeRewind())} open={request !== null}>
      <DialogContent
        className="flex max-h-[min(760px,calc(100vh-4rem))] w-[min(980px,calc(100vw-4rem))] max-w-none flex-col gap-3 overflow-y-auto"
        data-testid="rewind-confirm-dialog"
      >
        {request ? (
          // Structural identity of the target: the remount key (rule 4) AND the
          // per-changeset key the tree/diff panes scope their own state on.
          <RewindConfirmBody
            key={requestKey}
            onClose={closeRewind}
            request={request}
            requestKey={requestKey}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
