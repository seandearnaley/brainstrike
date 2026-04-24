import type {
  AssistantRunEvent,
  AssistantRunEventJson,
  AssistantRunEventStatus,
} from '@brainstrike/agent/run-events';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock3,
  Loader2,
  Radio,
} from 'lucide-react';
import * as m from 'motion/react-m';
import { useId, useMemo, useState } from 'react';
import { Button } from '../button';

interface AssistantRunTimelineProps {
  data: unknown;
}

interface AssistantRunTimelineDetailsProps {
  detail: string | undefined;
  detailsId: string;
  metadataEntries: [string, AssistantRunEventJson][];
}

const STATUS_LABELS: Record<AssistantRunEventStatus, string> = {
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
  info: 'Observed',
  running: 'Running',
};

function AssistantRunStatusIcon({ status }: { status: AssistantRunEventStatus }) {
  if (status === 'completed') {
    return <CheckCircle className="size-4 text-emerald-600 dark:text-emerald-500" />;
  }
  if (status === 'failed') {
    return <AlertCircle className="size-4 text-destructive" />;
  }
  if (status === 'cancelled') {
    return <AlertCircle className="size-4 text-muted-foreground" />;
  }
  if (status === 'running') {
    return <Loader2 className="size-4 animate-spin text-sky-600 dark:text-sky-400" />;
  }
  return <Radio className="size-4 text-sky-600 dark:text-sky-400" />;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAssistantRunEventStatus(value: unknown): value is AssistantRunEventStatus {
  return (
    value === 'cancelled' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'info' ||
    value === 'running'
  );
}

function isAssistantRunEvent(value: unknown): value is AssistantRunEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    typeof value['kind'] === 'string' &&
    typeof value['label'] === 'string' &&
    isAssistantRunEventStatus(value['status']) &&
    typeof value['timestamp'] === 'string'
  );
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
  detail,
  detailsId,
  metadataEntries,
}: AssistantRunTimelineDetailsProps) {
  return (
    <div className="border-t border-dashed px-4 py-3" id={detailsId}>
      {detail ? <p className="mb-2 text-muted-foreground text-xs">{detail}</p> : null}
      {metadataEntries.length > 0 ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {metadataEntries.map(([key, value]) => (
            <div className="contents" key={key}>
              <dt className="font-medium text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-words text-foreground/90">{formatJsonValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function AssistantRunTimeline({ data }: AssistantRunTimelineProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = useId();

  const event = isAssistantRunEvent(data) ? data : null;
  const metadataEntries = useMemo(
    () => (event?.metadata ? Object.entries(event.metadata) : []),
    [event]
  );

  if (!event) {
    return null;
  }

  const statusLabel = STATUS_LABELS[event.status];
  const durationLabel = formatDuration(event.durationMs);
  const hasDetails = Boolean(event.detail) || metadataEntries.length > 0;
  const isFailed = event.status === 'failed';

  return (
    <m.div
      className={`bs-run-timeline my-2 rounded-lg border ${
        isFailed ? 'border-destructive/50 bg-destructive/5' : 'border-border bg-background/70'
      }`}
      data-testid="assistant-run-timeline"
      layout
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 px-4 py-3">
        <div aria-hidden="true" className="bs-run-timeline-rail">
          <AssistantRunStatusIcon status={event.status} />
        </div>
        <div className="min-w-0">
          <p className={`font-medium text-sm ${isFailed ? 'text-destructive' : ''}`}>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{event.label}</span>
            </span>
            <span className="ml-2 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              {statusLabel}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span>{event.kind}</span>
            <span aria-hidden="true">·</span>
            <span>{formatTimestamp(event.timestamp)}</span>
            {durationLabel ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{durationLabel}</span>
              </>
            ) : null}
          </p>
        </div>
        {hasDetails ? (
          <Button
            aria-controls={isExpanded ? detailsId : undefined}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse run activity' : 'Expand run activity'}
            className="size-8"
            onClick={() => setIsExpanded((current) => !current)}
            size="icon"
            title={isExpanded ? 'Collapse run activity' : 'Expand run activity'}
            variant="ghost"
          >
            {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        ) : null}
      </div>
      {hasDetails && isExpanded ? (
        <AssistantRunTimelineDetails
          detail={event.detail}
          detailsId={detailsId}
          metadataEntries={metadataEntries}
        />
      ) : null}
    </m.div>
  );
}

AssistantRunTimeline.displayName = 'AssistantRunTimeline';
