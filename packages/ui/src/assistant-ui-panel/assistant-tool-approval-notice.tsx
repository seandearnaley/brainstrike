import { type CreateAppendMessage, useAui, useAuiState } from '@assistant-ui/react';
import type {
  AssistantToolApprovalAction,
  AssistantToolApprovalDecision,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/utils/logger';
import { AlertTriangle, Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '../button';

const logger = createLogger('AssistantToolApprovalNotice');

interface AssistantToolApprovalNoticeProps {
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAssistantToolApprovalRequest(value: unknown): value is AssistantToolApprovalRequest {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['toolName'] === 'string'
  );
}

/**
 * Human-readable reason for the approval, derived from the permission risk
 * bucket that resolved to `'ask'`. Returns `null` when the pause carried no
 * risk hint (e.g. a non-policy approval), so the notice omits the reason rather
 * than inventing one.
 */
const RISK_CATEGORY_REASON: Record<string, string> = {
  edit: 'edit (modifies files or state)',
  execute: 'execute (runs a command)',
  mcp: 'external MCP tool',
  read: 'read',
};

function resolveApprovalReason(approval: AssistantToolApprovalRequest): string | null {
  const risk = approval.riskCategory;
  if (typeof risk !== 'string') {
    return null;
  }
  return RISK_CATEGORY_REASON[risk] ?? risk;
}

function formatJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

type ApprovalRunOutcomeState = 'none' | 'pending' | 'retryable' | 'completed';

interface ApprovalRunOutcome {
  action: AssistantToolApprovalDecision | null;
  state: ApprovalRunOutcomeState;
}

const emptyApprovalRunOutcome: ApprovalRunOutcome = { action: null, state: 'none' };
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

function isMatchingApprovalAction(value: unknown, approval: AssistantToolApprovalRequest): boolean {
  return (
    isRecord(value) &&
    value['runId'] === approval.runId &&
    value['toolCallId'] === approval.toolCallId
  );
}

function getMessageRole(message: unknown): unknown {
  return isRecord(message) ? message['role'] : undefined;
}

function getMessageStatus(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) {
    return;
  }
  const status = message['status'];
  return isRecord(status) ? status : undefined;
}

function getToolApprovalActionFromMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return;
  }
  const custom = metadata['custom'];
  if (!isRecord(custom)) {
    return;
  }
  return custom[TOOL_APPROVAL_RUN_CONFIG_KEY];
}

function getToolApprovalDecision(value: unknown): AssistantToolApprovalDecision | null {
  if (!isRecord(value)) {
    return null;
  }
  const action = value['action'];
  return action === 'approve' || action === 'decline' ? action : null;
}

function resolveApprovalRunOutcome(
  messages: readonly unknown[],
  approval: AssistantToolApprovalRequest | null
): ApprovalRunOutcome {
  if (!approval) {
    return emptyApprovalRunOutcome;
  }

  let submittedMessageIndex = -1;
  let submittedAction: AssistantToolApprovalDecision | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const approvalAction = getToolApprovalActionFromMessage(message);
    if (getMessageRole(message) === 'user' && isMatchingApprovalAction(approvalAction, approval)) {
      submittedMessageIndex = index;
      submittedAction = getToolApprovalDecision(approvalAction);
      break;
    }
  }
  if (submittedMessageIndex < 0) {
    return emptyApprovalRunOutcome;
  }

  for (let index = submittedMessageIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const role = getMessageRole(message);
    if (role === 'user') {
      return { action: submittedAction, state: 'pending' };
    }
    if (role !== 'assistant') {
      continue;
    }

    const status = getMessageStatus(message);
    if (status?.['type'] === 'complete') {
      return { action: submittedAction, state: 'completed' };
    }
    if (status?.['type'] === 'incomplete') {
      return { action: submittedAction, state: 'retryable' };
    }
    return { action: submittedAction, state: 'pending' };
  }

  return { action: submittedAction, state: 'pending' };
}

export function AssistantToolApprovalNotice({ data }: AssistantToolApprovalNoticeProps) {
  const aui = useAui();
  const [isExpanded, setIsExpanded] = useState(false);
  const [submittedAction, setSubmittedAction] = useState<AssistantToolApprovalDecision | null>(
    null
  );
  const detailsId = useId();
  const approval = isAssistantToolApprovalRequest(data) ? data : null;
  const approvalReason = approval ? resolveApprovalReason(approval) : null;
  const approvalRunOutcomeKey = useAuiState((state) =>
    toApprovalRunOutcomeKey(resolveApprovalRunOutcome(state.thread.messages, approval))
  );
  const approvalRunOutcome = useMemo(
    () => fromApprovalRunOutcomeKey(approvalRunOutcomeKey),
    [approvalRunOutcomeKey]
  );
  const actionLockedByRun =
    approvalRunOutcome.state === 'pending' || approvalRunOutcome.state === 'completed';
  const detailEntries = useMemo(() => {
    if (!approval) {
      return [];
    }
    return [
      ['runId', approval.runId],
      ['toolCallId', approval.toolCallId],
      ['args', approval.args],
      ['resumeSchema', approval.resumeSchema],
    ].filter((entry): entry is [string, unknown] => entry[1] !== undefined);
  }, [approval]);
  const submitApprovalAction = useCallback(
    (action: AssistantToolApprovalDecision): void => {
      if (!(approval && submittedAction === null && !actionLockedByRun)) {
        return;
      }

      const approvalAction: AssistantToolApprovalAction = {
        action,
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
      };
      const verb = action === 'approve' ? 'Approved' : 'Declined';
      const message = {
        content: [{ text: `${verb} ${approval.toolName}.`, type: 'text' }],
        metadata: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction,
          },
        },
        role: 'user',
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction,
          },
        },
        startRun: true,
      } satisfies CreateAppendMessage;

      setSubmittedAction(action);
      try {
        void Promise.resolve(aui.thread().append(message)).catch((error: unknown) => {
          setSubmittedAction(null);
          logger.warn('Failed to append tool approval action', {
            error,
            runId: approval.runId,
            toolCallId: approval.toolCallId,
          });
        });
      } catch (error) {
        setSubmittedAction(null);
        logger.warn('Failed to append tool approval action', {
          error,
          runId: approval.runId,
          toolCallId: approval.toolCallId,
        });
      }
    },
    [actionLockedByRun, approval, aui, submittedAction]
  );

  useEffect(() => {
    if (submittedAction === null || approvalRunOutcome.state !== 'retryable') {
      return;
    }
    setSubmittedAction(null);
  }, [approvalRunOutcome.state, submittedAction]);

  if (!approval) {
    return null;
  }

  const displayedAction = submittedAction ?? (actionLockedByRun ? approvalRunOutcome.action : null);
  const approvalStatus =
    displayedAction === 'approve'
      ? 'Approved'
      : displayedAction === 'decline'
        ? 'Declined'
        : actionLockedByRun
          ? 'Submitted'
          : 'Pending';
  const actionButtonsDisabled = submittedAction !== null || actionLockedByRun;

  return (
    <div
      className="my-2 rounded-lg border border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20"
      data-testid="assistant-tool-approval-notice"
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 px-4 py-3">
        <div aria-hidden="true" className="pt-0.5">
          <AlertTriangle className="size-4 text-amber-700 dark:text-amber-400" />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="truncate">Tool approval required</span>
            </span>
            <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-100/70 px-2 py-0.5 text-[10px] text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              {approvalStatus}
            </span>
          </p>
          <p className="mt-1 truncate text-muted-foreground text-xs">{approval.toolName}</p>
          {approvalReason ? (
            <p className="mt-0.5 truncate text-amber-700 text-xs dark:text-amber-400">
              Requires approval: {approvalReason}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              aria-label={`Approve ${approval.toolName}`}
              disabled={actionButtonsDisabled}
              onClick={() => submitApprovalAction('approve')}
              size="sm"
              title={`Approve ${approval.toolName}`}
              variant="default"
            >
              <Check className="size-3.5" />
              Approve
            </Button>
            <Button
              aria-label={`Decline ${approval.toolName}`}
              disabled={actionButtonsDisabled}
              onClick={() => submitApprovalAction('decline')}
              size="sm"
              title={`Decline ${approval.toolName}`}
              variant="outline"
            >
              <X className="size-3.5" />
              Decline
            </Button>
          </div>
        </div>
        <Button
          aria-controls={isExpanded ? detailsId : undefined}
          aria-expanded={isExpanded}
          aria-label={
            isExpanded ? 'Collapse tool approval details' : 'Expand tool approval details'
          }
          className="size-8"
          onClick={() => setIsExpanded((current) => !current)}
          size="icon"
          title={isExpanded ? 'Collapse tool approval details' : 'Expand tool approval details'}
          variant="ghost"
        >
          {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      </div>
      {isExpanded ? (
        <div className="border-amber-500/30 border-t border-dashed px-4 py-3" id={detailsId}>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            {detailEntries.map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="font-medium text-muted-foreground">{key}</dt>
                <dd className="min-w-0 break-words text-foreground/90">
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-4">
                    {formatJsonValue(value)}
                  </pre>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

AssistantToolApprovalNotice.displayName = 'AssistantToolApprovalNotice';
