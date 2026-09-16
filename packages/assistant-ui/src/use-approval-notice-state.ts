import { useAui, useAuiState } from '@assistant-ui/react';
import type {
  AssistantToolApprovalAnswered,
  AssistantToolApprovalDecision,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/logging';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { useCallback, useMemo, useState } from 'react';
import { buildApprovalDecisionMessage } from './approval-decision-message';
import {
  resolveNoticeStatus,
  useDecisionQueueState,
  useDelegatedNoticeContext,
} from './approval-notice-status';
import { submitDecisionOrQueue } from './decision-dispatch';
import { useLiveDecisionTransport } from './live-decision-transport';
import {
  type RediscoveredPauseDisplay,
  readRediscoveredPauseDisplay,
} from './rediscovered-pause-display';
import {
  type ApprovalRunOutcome,
  type ApprovalRunOutcomeState,
  resolveApprovalRunOutcome,
} from './tool-decision-run-outcome';

const logger = createLogger('AssistantToolApprovalNotice');

const APPROVAL_RUN_OUTCOME_SEPARATOR = ':';

/**
 * `<action>:<state>:<decisionIndex>`. The index is what makes this key name ONE
 * attempt: a failed run, an answer from another surface and a second failed run
 * repeat `approve:retryable`, so a send failure or optimistic lock stamped
 * during the first would re-match the second on the pair alone. Flattening it
 * also keeps the thread selector referentially stable.
 */
type ApprovalRunOutcomeKey =
  `${AssistantToolApprovalDecision | 'none'}${typeof APPROVAL_RUN_OUTCOME_SEPARATOR}${ApprovalRunOutcomeState}${typeof APPROVAL_RUN_OUTCOME_SEPARATOR}${number}`;

function toApprovalRunOutcomeKey(outcome: ApprovalRunOutcome): ApprovalRunOutcomeKey {
  return `${outcome.action ?? 'none'}${APPROVAL_RUN_OUTCOME_SEPARATOR}${outcome.state}${APPROVAL_RUN_OUTCOME_SEPARATOR}${outcome.decisionIndex}`;
}

/** The half the card renders; the key's index discriminates, it never displays. */
function fromApprovalRunOutcomeKey(
  key: ApprovalRunOutcomeKey
): Pick<ApprovalRunOutcome, 'action' | 'state'> {
  const [action, state] = key.split(APPROVAL_RUN_OUTCOME_SEPARATOR) as [
    AssistantToolApprovalDecision | 'none',
    ApprovalRunOutcomeState,
  ];
  return { action: action === 'none' ? null : action, state };
}

/**
 * A decision this notice could not send, stamped with the run outcome the
 * ATTEMPT was made in — the same instant for a synchronous throw, while a live
 * delivery can be refused after the thread has moved on, and that message is
 * then dropped because the new status is authoritative.
 *
 * The stamp is what makes a message spend itself: any later answer for this
 * pause moves the outcome on — to a different DECISION, not merely a different
 * state, which is why the key carries the decision's index — and a failure
 * from before it no longer describes the card. The derivation MASKS a spent
 * failure rather than clearing it; clearing would take an effect, which is the
 * thing this shape avoids.
 */
interface SendFailure {
  readonly message: string;
  readonly outcomeKey: ApprovalRunOutcomeKey;
}

/**
 * A decision this notice has submitted, stamped with the run outcome it was
 * submitted in. The stamp is what spends the optimistic lock: the click takes
 * it in the outcome it saw, and any later answer for this pause moves the
 * outcome on and hands the card back.
 */
interface SubmittedDecision {
  readonly action: AssistantToolApprovalDecision;
  readonly outcomeKey: ApprovalRunOutcomeKey;
}

export interface ApprovalNoticeState {
  /** Approve / Decline / grant buttons disabled (queued, locked, in flight, or already run). */
  readonly actionButtonsDisabled: boolean;
  /**
   * The notice has an answer of any kind: the host's, a durable decision
   * state, the user's own (delivered, appended, queued, or in flight). The
   * card-vs-row chooser collapses an answered notice into a row.
   */
  readonly answered: boolean;
  /** A durable decision or a host answer: nothing may be submitted again. */
  readonly decisionLocked: boolean;
  /** "Explorer · <prompt excerpt>" for a delegated child; null for a root pause. */
  readonly delegationOwner: string | null;
  readonly hostAnswer: AssistantToolApprovalAnswered | null;
  readonly rediscovered: RediscoveredPauseDisplay | null;
  /**
   * Why the user's last decision was not sent (the append threw, or the host
   * refused the live decision), for as long as that failure still describes
   * the card. Null once a new submit starts, once the pause is answered by any
   * other route (the status is then authoritative), and once the run outcome
   * moves on from the attempt that failed.
   */
  readonly sendError: string | null;
  /** The header chip text (Pending / Queued / Approved / Declined / Allowed by session grant / …). */
  readonly status: string;
  readonly submitApprovalAction: (action: AssistantToolApprovalDecision) => void;
}

/**
 * Everything the card and the row need to know about one approval: the run
 * outcome after the user's own click, the host's answer from the thread
 * index, the follow-up queue state, and the decision submitter
 * (`submitDecisionOrQueue`: never cancels an in-flight run). Extracted
 * verbatim from the 1256-line notice on 2026-09-15 so the collapsed row can
 * share it with the full card.
 */
export function useApprovalNoticeState(
  approval: AssistantToolApprovalRequest
): ApprovalNoticeState {
  const aui = useAui();
  const [submittedDecision, setSubmittedDecision] = useState<SubmittedDecision | null>(null);
  const [sendFailure, setSendFailure] = useState<SendFailure | null>(null);
  const rediscovered = readRediscoveredPauseDisplay(approval);
  const approvalRunOutcomeKey = useAuiState((state) =>
    toApprovalRunOutcomeKey(resolveApprovalRunOutcome(state.thread.messages, approval))
  );
  const approvalRunOutcome = useMemo(
    () => fromApprovalRunOutcomeKey(approvalRunOutcomeKey),
    [approvalRunOutcomeKey]
  );
  const { delegationOwner, hostAnswer } = useDelegatedNoticeContext(approval);
  const { isRunning, queued, threadKey } = useDecisionQueueState(approval);
  const deliverLive = useLiveDecisionTransport();
  const decisionLocked =
    rediscovered?.decisionState !== undefined ||
    (hostAnswer !== null && approvalRunOutcome.state !== 'retryable');
  const actionLockedByRun =
    approvalRunOutcome.state === 'pending' || approvalRunOutcome.state === 'completed';
  // Derived, not adjusted in an effect: the optimistic lock belongs to the run
  // outcome the click was taken in, identified by `ApprovalRunOutcomeKey`. It
  // holds while the thread still reads that exact outcome — the double-click
  // window, and a live decision delivered into the running turn that appends no
  // message at all — and is spent as soon as the outcome moves on, which is how
  // a FAILED (`retryable`) resumed run hands the card back. Both halves need an
  // IDENTITY, not a value: reading `state !== 'retryable'` drops the lock a
  // RETRY click just took (the thread still reads the run that failed), while
  // keying on `{action, state}` alone resurrects a spent lock when the retried
  // run fails the same way — hence `decisionIndex` in the key.
  const submittedAction =
    submittedDecision?.outcomeKey === approvalRunOutcomeKey ? submittedDecision.action : null;

  const submitApprovalAction = useCallback(
    (action: AssistantToolApprovalDecision): void => {
      if (!(submittedAction === null && !actionLockedByRun && !decisionLocked)) {
        return;
      }
      setSendFailure(null);
      const decision = buildApprovalDecisionMessage(approval, action);
      const sendNow = (queuedMessage: typeof decision.message): void => {
        setSubmittedDecision({ action, outcomeKey: approvalRunOutcomeKey });
        // `append` returns void in the installed assistant-ui: a failed run
        // arrives as thread state (`retryable` below), never as a rejection
        // here. Only a synchronous throw (e.g. an unavailable thread scope)
        // is ours to report.
        try {
          aui.thread().append(queuedMessage);
        } catch (error) {
          setSubmittedDecision(null);
          setSendFailure({ message: getErrorMessage(error), outcomeKey: approvalRunOutcomeKey });
          logger.warn('Failed to append tool approval action', {
            error,
            runId: approval.runId,
            toolCallId: approval.toolCallId,
          });
        }
      };
      // A decision never cancels an in-flight run: while the thread runs it
      // is delivered INTO the run when the host offers a live transport, and
      // otherwise waits in the follow-up queue (chip + "Queued" chip on this
      // notice) until the run ends (`decision-dispatch.ts`). The notice locks
      // for the round trip so a second click cannot race the first.
      setSubmittedDecision({ action, outcomeKey: approvalRunOutcomeKey });
      submitDecisionOrQueue({
        append: sendNow,
        deliverLive,
        identityKey: decision.identityKey,
        isRunning,
        message: decision.message,
        text: decision.text,
        threadKey,
      }).then(
        (outcome) => {
          if (outcome === 'queued') {
            setSubmittedDecision(null);
          }
        },
        (error: unknown) => {
          setSubmittedDecision(null);
          setSendFailure({ message: getErrorMessage(error), outcomeKey: approvalRunOutcomeKey });
          logger.warn('Failed to deliver tool approval action', {
            error,
            runId: approval.runId,
            toolCallId: approval.toolCallId,
          });
        }
      );
    },
    [
      actionLockedByRun,
      approval,
      approvalRunOutcomeKey,
      aui,
      decisionLocked,
      deliverLive,
      isRunning,
      submittedAction,
      threadKey,
    ]
  );

  // Derived, not adjusted in an effect: a notice the user can no longer act on
  // has an authoritative status, and a failure from an earlier attempt beside
  // it would contradict it. Deriving also avoids a frame of stale text.
  const sendError =
    sendFailure?.outcomeKey === approvalRunOutcomeKey &&
    !(queued || decisionLocked || actionLockedByRun)
      ? sendFailure.message
      : null;
  const displayedAction = submittedAction ?? (actionLockedByRun ? approvalRunOutcome.action : null);
  const status = resolveNoticeStatus({
    actionLockedByRun,
    displayedAction,
    hostAnswer,
    queued,
    rediscovered,
  });
  return {
    actionButtonsDisabled:
      queued || decisionLocked || submittedAction !== null || actionLockedByRun,
    answered: decisionLocked || actionLockedByRun || submittedAction !== null || queued,
    decisionLocked,
    delegationOwner,
    hostAnswer,
    rediscovered,
    sendError,
    status,
    submitApprovalAction,
  };
}
