import { useAui, useAuiState } from '@assistant-ui/react';
import type {
  AssistantToolApprovalAnswered,
  AssistantToolApprovalDecision,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/logging';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { useCallback, useEffect, useMemo, useState } from 'react';
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

type ApprovalRunOutcomeKey =
  `${AssistantToolApprovalDecision | 'none'}${typeof APPROVAL_RUN_OUTCOME_SEPARATOR}${ApprovalRunOutcomeState}`;

function toApprovalRunOutcomeKey(outcome: ApprovalRunOutcome): ApprovalRunOutcomeKey {
  return `${outcome.action ?? 'none'}${APPROVAL_RUN_OUTCOME_SEPARATOR}${outcome.state}`;
}

function fromApprovalRunOutcomeKey(key: ApprovalRunOutcomeKey): ApprovalRunOutcome {
  const [action, state] = key.split(APPROVAL_RUN_OUTCOME_SEPARATOR) as [
    AssistantToolApprovalDecision | 'none',
    ApprovalRunOutcomeState,
  ];
  return { action: action === 'none' ? null : action, state };
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
   * refused the live decision); null once a new submit starts.
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
  const [submittedAction, setSubmittedAction] = useState<AssistantToolApprovalDecision | null>(
    null
  );
  const [sendError, setSendError] = useState<string | null>(null);
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
  const decisionLocked = rediscovered?.decisionState !== undefined || hostAnswer !== null;
  const actionLockedByRun =
    approvalRunOutcome.state === 'pending' || approvalRunOutcome.state === 'completed';

  const submitApprovalAction = useCallback(
    (action: AssistantToolApprovalDecision): void => {
      if (!(submittedAction === null && !actionLockedByRun && !decisionLocked)) {
        return;
      }
      setSendError(null);
      const decision = buildApprovalDecisionMessage(approval, action);
      const sendNow = (queuedMessage: typeof decision.message): void => {
        setSubmittedAction(action);
        // `append` returns void in the installed assistant-ui: a failed run
        // arrives as thread state (`retryable` below), never as a rejection
        // here. Only a synchronous throw (e.g. an unavailable thread scope)
        // is ours to report.
        try {
          aui.thread().append(queuedMessage);
        } catch (error) {
          setSubmittedAction(null);
          setSendError(getErrorMessage(error));
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
      setSubmittedAction(action);
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
            setSubmittedAction(null);
          }
        },
        (error: unknown) => {
          setSubmittedAction(null);
          setSendError(getErrorMessage(error));
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
      aui,
      decisionLocked,
      deliverLive,
      isRunning,
      submittedAction,
      threadKey,
    ]
  );

  useEffect(() => {
    if (approvalRunOutcome.state !== 'retryable') {
      return;
    }
    setSubmittedAction(null);
    // The card unlocks for a retry, so a failure from an earlier attempt is
    // spent: it must not reappear beside the re-enabled buttons.
    setSendError(null);
  }, [approvalRunOutcome.state]);

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
    // Only a notice the user can still act on reports a send failure. Once the
    // pause is answered by any other route — the composer's approval strip, a
    // host answer, a durable decision — the status is authoritative and a
    // stale failure beside it would contradict it.
    sendError: queued || decisionLocked || actionLockedByRun ? null : sendError,
    status,
    submitApprovalAction,
  };
}
