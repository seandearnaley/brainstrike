/**
 * The trigger that ends a Conversation Rewind's redo window (BST-1115, W5 T4b).
 *
 * The settled semantics are "tombstones survive until the NEXT USER MESSAGE
 * finalizes them". Nothing in production fired that until this hook, so the
 * redo window never closed and tombstoned messages were never hard-deleted —
 * half the rewind contract was unimplemented rather than merely unwired.
 *
 * TWO SIGNALS, BOTH REQUIRED — this is the whole design and neither half is
 * sufficient:
 *
 *   1. `markUserAuthoredSend` is the composer's submit (`onThreadRunStart`,
 *      `ComposerPrimitive.Root#onSubmitCapture`). It is the ONLY event that
 *      means "the human pressed send". A tool-approval resume, a stream
 *      replay/reattach and a plan-mode continuation all start runs WITHOUT it.
 *      It is not sufficient alone: assistant-ui's composer calls
 *      `form.requestSubmit()` on Enter unconditionally, so an Enter on an
 *      EMPTY composer fires this submit, `useComposerSend()` returns null and
 *      no message is ever sent. Finalizing there would hard-delete a redoable
 *      rewind on a keystroke that did nothing.
 *   2. `finalizeAfterRunCreated` runs at the run-creation seam, composed
 *      around `prepareRequestData` — after `repository.createThreadRun` has
 *      minted the run (the documented SOLE runId producer; this composes
 *      around it and never becomes a second one). It is not sufficient alone
 *      either: every resume passes through it too.
 *
 * Their CONJUNCTION is exactly "a user-authored message started a new run".
 * The arming flag is read-and-cleared, so one submit can license at most one
 * finalization; an armed submit that never produces a run leaves the flag set
 * for the next run, which is harmless because by then the tombstones a real
 * send would have finalized are already gone.
 *
 * THE SEND IS NEVER BLOCKED. `finalizeAfterRunCreated` returns void and is
 * called for effect: the IPC round-trip, its result, and any failure are all
 * handled off the send path. This composes with — and does not contradict —
 * `finalizeThreadRewinds`'s rule that a failed message delete PROPAGATES and
 * leaves the tombstones in place. That rule protects the DATA (a thread whose
 * messages could not be removed must stay hidden); this one protects the USER
 * (their prompt is not held hostage to a cleanup they never asked for). A
 * failure is logged AND toasted, never swallowed, and the tombstones simply
 * stay outstanding for the next send to retry.
 *
 * Web has no rewind at all, so an absent bridge means there is nothing to
 * finalize — capability gating, not a fallback.
 */
import { createLogger } from '@brainstrike/logging';
// The module-scope `toast` rather than `useToast()`: this hook is called from
// `AssistantUiPanelWrapper`, and `useToast` SUBSCRIBES its caller to the global
// toast store, which would re-render the whole assistant panel every time any
// toast anywhere is raised, dismissed or reaped. Nothing here reads toast
// state — it only raises one — so the subscription would be pure cost on the
// send path.
import { toast } from '@brainstrike/ui';
import { useCallback, useMemo, useRef } from 'react';
import { resolveChangesBridge } from './changes-bridge';

const logger = createLogger('RewindFinalization');

type PrepareRequestData = (
  abortSignal?: AbortSignal,
  turnAnchorMessageId?: string | null,
  runConfig?: unknown
) => Promise<Record<string, unknown>>;

export interface UseRewindFinalizationArgs {
  /** The wrapper's raw run-creation seam. Returned wrapped, never replaced. */
  readonly prepareRequestData: PrepareRequestData;
  readonly threadId: string | undefined;
}

export interface UseRewindFinalizationResult {
  /** Wire to the composer's submit (`onThreadRunStart`). Arms the next run. */
  readonly markUserAuthoredSend: () => void;
  /**
   * `prepareRequestData` with finalization composed after run creation. Hand
   * THIS to the panel: it resolves exactly what the original resolved, on the
   * original's schedule.
   */
  readonly prepareRequestData: PrepareRequestData;
}

export function useRewindFinalization({
  prepareRequestData,
  threadId,
}: UseRewindFinalizationArgs): UseRewindFinalizationResult {
  // Resolved ONCE per hook instance, like `use-rewind.ts`: re-resolving would
  // re-log on every send for a malformed bridge.
  const bridge = useMemo(() => resolveChangesBridge(), []);
  const userAuthoredSendPendingRef = useRef(false);

  const markUserAuthoredSend = useCallback((): void => {
    userAuthoredSendPendingRef.current = true;
  }, []);

  const finalizeAfterRunCreated = useCallback((): void => {
    // Read-and-clear: one submit licenses at most one finalization.
    const armed = userAuthoredSendPendingRef.current;
    userAuthoredSendPendingRef.current = false;
    if (!(armed && bridge && threadId)) {
      return;
    }
    void (async () => {
      try {
        const result = await bridge.finalizeRewinds({ threadId });
        if (!result.ok) {
          logger.error('Failed to finalize thread rewinds', { error: result.error, threadId });
          toast({
            description: `${result.error} The rewound messages stay hidden and will be finalized by your next message.`,
            title: 'Could not finalize the rewind',
            variant: 'destructive',
          });
          return;
        }
        if (result.value.finalized) {
          logger.info('Finalized thread rewinds', {
            deletedMessageCount: result.value.deletedMessageIds.length,
            rewindCount: result.value.rewindIds.length,
            threadId,
          });
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.error('Failed to finalize thread rewinds', { error: caught, threadId });
        toast({
          description: `${message} The rewound messages stay hidden and will be finalized by your next message.`,
          title: 'Could not finalize the rewind',
          variant: 'destructive',
        });
      }
    })();
  }, [bridge, threadId]);

  const prepareRequestDataAndFinalize = useCallback<PrepareRequestData>(
    async (abortSignal, turnAnchorMessageId, runConfig) => {
      const prepared = await prepareRequestData(abortSignal, turnAnchorMessageId, runConfig);
      // An abort that lands AFTER the run row exists still aborts the send:
      // `prepareRequest` throws the reason once this resolves. No message was
      // authored, so nothing finalizes; the arming flag stays set and the retry
      // that actually sends closes the window. Mirrors the lifecycle hook's own
      // `runWhileRequestPreparationActive` gate.
      if (abortSignal?.aborted !== true) {
        // Deliberately not awaited: the send is what the user asked for, and a
        // cleanup they did not ask for may never delay or fail it.
        finalizeAfterRunCreated();
      }
      return prepared;
    },
    [finalizeAfterRunCreated, prepareRequestData]
  );

  return { markUserAuthoredSend, prepareRequestData: prepareRequestDataAndFinalize };
}
