import type { AssistantRunEventJson } from '@brainstrike/assistant-contract';
import { readAssistantRunEvent } from '@brainstrike/assistant-contract';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  CircleSlash,
  Radio,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { AssistantRunEventDisplayStatus } from './assistant-run-event-derivation';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { categoryTintClasses, classifyRunEvent } from './tool-visual-classification';

interface AssistantRunTimelineProps {
  data: unknown;
  /** Number of consecutive identical events this row represents (rendered as ×n). */
  repeatCount?: number;
  statusOverride?: AssistantRunEventDisplayStatus;
}

const STATUS_LABELS: Record<AssistantRunEventDisplayStatus, string> = {
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
  info: 'Observed',
  interrupted: 'Interrupted',
  running: 'Running',
};

function AssistantRunStatusIcon({ status }: { status: AssistantRunEventDisplayStatus }) {
  if (status === 'completed') {
    return <CheckCircle className="size-3.5 text-success" />;
  }
  if (status === 'failed') {
    return <AlertCircle className="size-3.5 text-destructive" />;
  }
  if (status === 'cancelled') {
    return <AlertCircle className="size-3.5 text-muted-foreground" />;
  }
  if (status === 'interrupted') {
    return <CircleSlash className="size-3.5 text-muted-foreground" />;
  }
  if (status === 'running') {
    return <CircleDashed className="size-3.5 text-muted-foreground" />;
  }
  // Info events inherit the category accent color from the wrapping rail span.
  return <Radio className="size-3.5" />;
}

function formatJsonValue(value: AssistantRunEventJson): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) {
    return;
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function AssistantRunTimelineDetails({
  detailsId,
  kind,
  metadataEntries,
}: {
  detailsId: string;
  kind: string;
  metadataEntries: [string, AssistantRunEventJson][];
}) {
  return (
    <div
      className="mx-2 mb-1.5 rounded-md border border-border/50 bg-muted/30 px-3 py-2"
      id={detailsId}
    >
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <div className="contents">
          <dt className="font-medium text-muted-foreground">kind</dt>
          <dd className="min-w-0 break-words text-foreground/90">{kind}</dd>
        </div>
        {metadataEntries.map(([key, value]) => (
          <div className="contents" key={key}>
            <dt className="font-medium text-muted-foreground">{key}</dt>
            <dd className="min-w-0 break-words text-foreground/90">{formatJsonValue(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function AssistantRunTimeline({
  data,
  repeatCount,
  statusOverride,
}: AssistantRunTimelineProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = useId();

  const event = readAssistantRunEvent(data) ?? null;
  const metadataEntries = useMemo(
    () => (event?.metadata ? Object.entries(event.metadata) : []),
    [event]
  );

  if (!event) {
    return null;
  }

  const eventStatus = statusOverride ?? event.status;
  const statusLabel = STATUS_LABELS[eventStatus];
  const durationLabel = formatDuration(event.durationMs);
  const isFailed = eventStatus === 'failed';
  const isRunning = eventStatus === 'running';
  const label =
    event.kind === 'tool.approval.requested'
      ? eventStatus === 'interrupted'
        ? 'Approval was pending'
        : 'Approval requested'
      : event.label;

  const toolName =
    typeof event.metadata?.['toolName'] === 'string' ? event.metadata['toolName'] : undefined;
  const category = classifyRunEvent(event.kind, toolName);
  const tint = categoryTintClasses(category);

  // Run events render as quiet single-line activity rows: tool-call cards are
  // the visually dominant element in the thread, so lifecycle/memory events
  // stay compact with status, label, inline detail, and timing on one line.
  return (
    <div
      className={`bs-run-timeline rounded-md ${isFailed ? 'bg-destructive/5' : ''}`}
      data-testid="assistant-run-timeline"
      data-tool-category={category}
    >
      <div className="flex min-w-0 items-center gap-2 px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={statusLabel}
              className={`inline-flex shrink-0 ${isFailed ? 'text-destructive' : tint.rail}`}
              role="img"
            >
              <AssistantRunStatusIcon status={eventStatus} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{statusLabel}</TooltipContent>
        </Tooltip>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span
            className={`truncate font-medium text-xs ${
              isFailed ? 'text-destructive' : 'text-foreground/85'
            }`}
          >
            {label}
          </span>
          {repeatCount !== undefined && repeatCount > 1 ? (
            <span
              className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums"
              title={`Repeated ${repeatCount} times`}
            >
              ×{repeatCount}
            </span>
          ) : null}
          {event.detail ? (
            <span className="truncate text-[11px] text-muted-foreground" title={event.detail}>
              {event.detail}
            </span>
          ) : null}
        </span>
        {isRunning ? (
          <AssistantThinkingIndicator
            className="shrink-0 text-xs"
            markClassName="size-3.5"
            textClassName="truncate"
          />
        ) : null}
        {durationLabel ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {durationLabel}
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
          {formatTimestamp(event.timestamp)}
        </span>
        <Button
          aria-controls={isExpanded ? detailsId : undefined}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse run activity' : 'Expand run activity'}
          className="size-6 shrink-0 text-muted-foreground"
          onClick={() => setIsExpanded((current) => !current)}
          size="icon"
          title={isExpanded ? 'Collapse run activity' : 'Expand run activity'}
          variant="ghost"
        >
          {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </Button>
      </div>
      {isExpanded ? (
        <AssistantRunTimelineDetails
          detailsId={detailsId}
          kind={event.kind}
          metadataEntries={metadataEntries}
        />
      ) : null}
    </div>
  );
}

AssistantRunTimeline.displayName = 'AssistantRunTimeline';
