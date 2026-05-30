import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
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
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export function AssistantToolApprovalNotice({ data }: AssistantToolApprovalNoticeProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = useId();
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

  if (!approval) {
    return null;
  }

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
              Pending
            </span>
          </p>
          <p className="mt-1 truncate text-muted-foreground text-xs">{approval.toolName}</p>
        </div>
        {detailEntries.length > 0 ? (
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
        ) : null}
      </div>
      {isExpanded && detailEntries.length > 0 ? (
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
