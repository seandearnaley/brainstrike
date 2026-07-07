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
  Radio,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { categoryTintClasses, classifyRunEvent } from './tool-visual-classification';

interface AssistantRunTimelineProps {
  data: unknown;
  /** Number of consecutive identical events this row represents (rendered as ×n). */
  repeatCount?: number;
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
    return <CheckCircle className="size-3.5 text-emerald-600 dark:text-emerald-500" />;
  }
  if (status === 'failed') {
    return <AlertCircle className="size-3.5 text-destructive" />;
  }
  if (status === 'cancelled') {
    return <AlertCircle className="size-3.5 text-muted-foreground" />;
  }
  if (status === 'running') {
    return <CircleDashed className="size-3.5 text-muted-foreground" />;
  }
  // Info events inherit the category accent color from the wrapping rail span.
  return <Radio className="size-3.5" />;
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

/**
 * Run-event rows that must surface even when background activity is hidden
 * (non-Developer detail). A failed or cancelled TURN would otherwise be silently
 * swallowed: tool-level failures already surface on their ToolFallback cards, and
 * a run rejected before any stream part renders via AssistantMessageError — but a
 * mid-run failure/cancellation has neither, so its terminal run-event row is the
 * only visible signal. Matched by `kind` (not `status`) on purpose: `tool.failed`
 * is also `status: 'failed'`, and re-surfacing it here would double-report the
 * card.
 */
export function isAlwaysVisibleRunEvent(data: unknown): boolean {
  if (!isAssistantRunEvent(data)) {
    return false;
  }
  return data.kind === 'run.failed' || data.kind === 'run.cancelled';
}

export function getMessageParts(message: unknown): readonly unknown[] {
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

/** True when the thread contains a tool-call message part with the event's toolCallId. */
export function hasToolCallPartForEvent(
  messages: readonly unknown[],
  event: AssistantRunEvent
): boolean {
  if (!event.kind.startsWith('tool.')) {
    return false;
  }
  const toolCallId = event.metadata?.['toolCallId'];
  if (typeof toolCallId !== 'string') {
    return false;
  }
  return messages.some((message) =>
    getMessageParts(message).some(
      (part) => isRecord(part) && part['type'] === 'tool-call' && part['toolCallId'] === toolCallId
    )
  );
}

function isSameRunEventContent(a: AssistantRunEvent, b: AssistantRunEvent): boolean {
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    (a.detail ?? '') === (b.detail ?? '') &&
    a.status === b.status
  );
}

/**
 * True when a later event in the list is the exact terminal counterpart
 * (completed/failed kind, same run + tool scope) of this `.started` event.
 * The terminal row carries the label and duration, so the started row is
 * redundant once it exists.
 */
function hasTerminalRowForStartedEvent(
  events: readonly AssistantRunEvent[],
  event: AssistantRunEvent,
  index: number
): boolean {
  if (!event.kind.endsWith('.started')) {
    return false;
  }
  const completedKind = getMatchingCompletedKind(event.kind);
  const failedKind = getMatchingFailedKind(event.kind);
  return events
    .slice(index + 1)
    .some(
      (candidate) =>
        (candidate.kind === completedKind || (failedKind && candidate.kind === failedKind)) &&
        hasSameRunScope(event, candidate) &&
        hasSameToolScope(event, candidate)
    );
}

export interface AssistantRunEventRenderPlan {
  hidden: boolean;
  repeatCount: number;
}

const VISIBLE_ONCE: AssistantRunEventRenderPlan = { hidden: false, repeatCount: 1 };
const HIDDEN: AssistantRunEventRenderPlan = { hidden: true, repeatCount: 1 };

/**
 * Decides whether a run-event row should render, and with what repeat count.
 * Suppresses three kinds of duplication:
 * 1. tool.* events whose tool call already renders as a ToolFallback card
 *    (the card is the authoritative status display for that call),
 * 2. `.started` rows once their terminal (completed/failed) row exists,
 * 3. consecutive identical rows — the first one renders with a ×n count.
 */
export function resolveAssistantRunEventRenderPlan(
  messages: readonly unknown[],
  data: unknown
): AssistantRunEventRenderPlan {
  const event = isAssistantRunEvent(data) ? data : null;
  if (!event) {
    return VISIBLE_ONCE;
  }
  if (hasToolCallPartForEvent(messages, event)) {
    return HIDDEN;
  }

  const events = getRunEventsFromMessages(messages);
  const index = events.findIndex((candidate) => candidate.id === event.id);
  if (index < 0) {
    return VISIBLE_ONCE;
  }
  if (hasTerminalRowForStartedEvent(events, event, index)) {
    return HIDDEN;
  }

  const previous = events[index - 1];
  if (previous && isSameRunEventContent(previous, event)) {
    return HIDDEN;
  }
  let repeatCount = 1;
  for (let i = index + 1; i < events.length; i++) {
    const candidate = events[i];
    if (!(candidate && isSameRunEventContent(candidate, event))) {
      break;
    }
    repeatCount++;
  }
  return repeatCount === 1 ? VISIBLE_ONCE : { hidden: false, repeatCount };
}

export function resolveAssistantRunEventStatus(
  messages: readonly unknown[],
  event: AssistantRunEvent | null
): AssistantRunEventStatus {
  if (event?.status !== 'running') {
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
            {event.label}
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
