import type {
  AssistantRunEvent,
  AssistantRunEventJson,
  AssistantRunEventKind,
  AssistantRunEventStatus,
} from '@brainstrike/assistant-contract';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Clock3,
  Radio,
} from 'lucide-react';
import * as m from 'motion/react-m';
import { useId, useMemo, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { categoryTintClasses, classifyRunEvent } from './tool-visual-classification';

interface AssistantRunTimelineProps {
  data: unknown;
  statusOverride?: AssistantRunEventStatus;
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
    return <CircleDashed className="size-4 text-muted-foreground" />;
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

function getMessageParts(message: unknown): readonly unknown[] {
  if (!isRecord(message)) {
    return [];
  }
  const content = message['content'];
  if (Array.isArray(content)) {
    return content;
  }
  const parts = message['parts'];
  return Array.isArray(parts) ? parts : [];
}

function getRunEventFromPart(part: unknown): AssistantRunEvent | null {
  if (!isRecord(part)) {
    return null;
  }
  if (part['name'] !== ASSISTANT_RUN_EVENT_DATA_NAME) {
    return null;
  }
  return isAssistantRunEvent(part['data']) ? part['data'] : null;
}

function getRunEventsFromMessages(messages: readonly unknown[]): AssistantRunEvent[] {
  return messages.flatMap((message) =>
    getMessageParts(message)
      .map(getRunEventFromPart)
      .filter((event) => event !== null)
  );
}

function hasSameRunScope(event: AssistantRunEvent, candidate: AssistantRunEvent): boolean {
  return !(event.runId && candidate.runId) || event.runId === candidate.runId;
}

export function getMatchingCompletedKind(
  kind: AssistantRunEventKind
): AssistantRunEventKind | null {
  if (kind === 'run.started') {
    return 'run.finished';
  }
  if (kind === 'tool.started') {
    return 'tool.completed';
  }
  if (kind.startsWith('run.') && kind.endsWith('.started')) {
    return kind.replace(/\.started$/, '.finished') as AssistantRunEventKind;
  }
  if (kind.endsWith('.started')) {
    return kind.replace(/\.started$/, '.completed') as AssistantRunEventKind;
  }
  return null;
}

function getMatchingFailedKind(kind: AssistantRunEventKind): AssistantRunEventKind | null {
  if (kind === 'run.started') {
    return 'run.failed';
  }
  if (kind === 'tool.started') {
    return 'tool.failed';
  }
  return null;
}

function hasSameToolScope(event: AssistantRunEvent, candidate: AssistantRunEvent): boolean {
  if (event.kind !== 'tool.started') {
    return true;
  }
  const toolCallId = event.metadata?.['toolCallId'];
  return typeof toolCallId !== 'string' || candidate.metadata?.['toolCallId'] === toolCallId;
}

function resolveFromLaterRunEvent(
  event: AssistantRunEvent,
  candidate: AssistantRunEvent,
  matchingCompletedKind: AssistantRunEventKind | null,
  matchingFailedKind: AssistantRunEventKind | null
): AssistantRunEventStatus | null {
  if (!hasSameRunScope(event, candidate)) {
    return null;
  }
  if (candidate.kind === matchingCompletedKind && hasSameToolScope(event, candidate)) {
    return 'completed';
  }
  if (
    matchingFailedKind &&
    candidate.kind === matchingFailedKind &&
    hasSameToolScope(event, candidate)
  ) {
    return 'failed';
  }
  if (candidate.kind === 'run.failed') {
    return 'failed';
  }
  if (candidate.kind === 'run.cancelled') {
    return 'cancelled';
  }
  if (event.kind !== 'run.started' && candidate.kind === 'run.finished') {
    return 'completed';
  }
  return null;
}

export function resolveAssistantRunEventStatus(
  messages: readonly unknown[],
  event: AssistantRunEvent | null
): AssistantRunEventStatus {
  if (!event || event.status !== 'running') {
    return event?.status ?? 'info';
  }

  const matchingCompletedKind = getMatchingCompletedKind(event.kind);
  const matchingFailedKind = getMatchingFailedKind(event.kind);
  if (!(matchingCompletedKind || matchingFailedKind)) {
    return event.status;
  }

  const runEvents = getRunEventsFromMessages(messages);
  const eventIndex = runEvents.findIndex((candidate) => candidate.id === event.id);
  const laterEvents = eventIndex >= 0 ? runEvents.slice(eventIndex + 1) : runEvents;

  for (const candidate of laterEvents) {
    const resolvedStatus = resolveFromLaterRunEvent(
      event,
      candidate,
      matchingCompletedKind,
      matchingFailedKind
    );
    if (resolvedStatus) {
      return resolvedStatus;
    }
  }

  return event.status;
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
  durationLabel,
  kind,
  metadataEntries,
}: {
  detail: string | undefined;
  detailsId: string;
  durationLabel: string | undefined;
  kind: string;
  metadataEntries: [string, AssistantRunEventJson][];
}) {
  return (
    <div className="border-t border-dashed px-3 py-2" id={detailsId}>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <div className="contents">
          <dt className="font-medium text-muted-foreground">kind</dt>
          <dd className="min-w-0 break-words text-foreground/90">{kind}</dd>
        </div>
        {durationLabel ? (
          <div className="contents">
            <dt className="font-medium text-muted-foreground">duration</dt>
            <dd className="text-foreground/90">{durationLabel}</dd>
          </div>
        ) : null}
        {metadataEntries.map(([key, value]) => (
          <div className="contents" key={key}>
            <dt className="font-medium text-muted-foreground">{key}</dt>
            <dd className="min-w-0 break-words text-foreground/90">{formatJsonValue(value)}</dd>
          </div>
        ))}
      </dl>
      {detail ? <p className="mt-2 text-muted-foreground text-xs">{detail}</p> : null}
    </div>
  );
}

export function AssistantRunTimeline({ data, statusOverride }: AssistantRunTimelineProps) {
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

  const eventStatus = statusOverride ?? event.status;
  const statusLabel = STATUS_LABELS[eventStatus];
  const durationLabel = formatDuration(event.durationMs);
  const isFailed = eventStatus === 'failed';
  const isRunning = eventStatus === 'running';

  const toolName =
    typeof event.metadata?.['toolName'] === 'string' ? event.metadata['toolName'] : undefined;
  const category = classifyRunEvent(event.kind, toolName);
  const tint = categoryTintClasses(category);

  // Expander is always available since kind always provides fold content
  const hasDetails = true;

  return (
    <m.div
      className={`bs-run-timeline my-1.5 rounded-lg border ${
        isFailed ? 'border-destructive/50 bg-destructive/5' : tint.card
      }`}
      data-testid="assistant-run-timeline"
      data-tool-category={category}
      layout
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 px-3 py-2">
        <div className={`bs-run-timeline-rail ${isFailed ? 'text-destructive' : tint.rail}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={statusLabel} className="inline-flex" role="img">
                <AssistantRunStatusIcon status={eventStatus} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{statusLabel}</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-w-0">
          <p className={`font-medium text-sm ${isFailed ? 'text-destructive' : ''}`}>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{event.label}</span>
            </span>
          </p>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
            {isRunning ? (
              <AssistantThinkingIndicator markClassName="size-3.5" textClassName="truncate" />
            ) : null}
            <span>{formatTimestamp(event.timestamp)}</span>
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
          durationLabel={durationLabel}
          kind={event.kind}
          metadataEntries={metadataEntries}
        />
      ) : null}
    </m.div>
  );
}

AssistantRunTimeline.displayName = 'AssistantRunTimeline';
