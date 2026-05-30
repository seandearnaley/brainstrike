import { type CreateAppendMessage, useAui, useAuiState } from '@assistant-ui/react';
import type {
  AssistantToolApprovalAction,
  AssistantToolApprovalDecision,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { AlertTriangle, Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../button';

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

function formatJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export function AssistantToolApprovalNotice({ data }: AssistantToolApprovalNoticeProps) {
  const aui = useAui();
  const [isExpanded, setIsExpanded] = useState(false);
  const [submittedAction, setSubmittedAction] = useState<AssistantToolApprovalDecision | null>(
    null
  );
  const failedRunCountAtSubmissionRef = useRef<number | null>(null);
  const detailsId = useId();
  const failedRunCount = useAuiState((state) =>
    state.thread.messages.reduce((count, message) => {
      const status = message.status;
      return message.role === 'assistant' &&
        status?.type === 'incomplete' &&
        status.reason === 'error'
        ? count + 1
        : count;
    }, 0)
  );
  const approval = isAssistantToolApprovalRequest(data) ? data : null;
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
      if (!(approval && submittedAction === null)) {
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
        content: [{ type: 'text', text: `${verb} ${approval.toolName}.` }],
        role: 'user',
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction,
          },
        },
        startRun: true,
      } satisfies CreateAppendMessage;

      failedRunCountAtSubmissionRef.current = failedRunCount;
      setSubmittedAction(action);
      try {
        aui.thread().append(message);
      } catch (error) {
        failedRunCountAtSubmissionRef.current = null;
        setSubmittedAction(null);
        throw error;
      }
    },
    [approval, aui, failedRunCount, submittedAction]
  );

  useEffect(() => {
    if (submittedAction === null) {
      return;
    }
    const failedRunCountAtSubmission = failedRunCountAtSubmissionRef.current;
    if (failedRunCountAtSubmission === null || failedRunCount <= failedRunCountAtSubmission) {
      return;
    }
    failedRunCountAtSubmissionRef.current = null;
    setSubmittedAction(null);
  }, [failedRunCount, submittedAction]);

  if (!approval) {
    return null;
  }

  const approvalStatus =
    submittedAction === 'approve'
      ? 'Approved'
      : submittedAction === 'decline'
        ? 'Declined'
        : 'Pending';
  const actionButtonsDisabled = submittedAction !== null;

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
