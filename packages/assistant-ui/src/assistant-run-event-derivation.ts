import type {
  AssistantRunEvent,
  AssistantRunEventKind,
  AssistantRunEventStatus,
} from '@brainstrike/assistant-contract';
import {
  readAssistantRunEvent,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';
import { UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND } from '@brainstrike/assistant-contract/tool-suspend';

/**
 * Pure run-event derivation: pairing `.started` rows with their terminal
 * counterparts, resolving row statuses, and deciding render plans.
 *
 * Kept out of `assistant-run-timeline.tsx` so that file exports only its
 * component and Fast Refresh can preserve state across edits
 * (`react-refresh/only-export-components`). Nothing here touches JSX or hooks.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Run-event rows that must surface even when background activity is hidden
 * (non-Developer detail). A failed or cancelled TURN would otherwise be silently
 * swallowed: an ordinary tool failure already surfaces on its ToolFallback card,
 * and a run rejected before any stream part renders via AssistantMessageError —
 * but a mid-run failure/cancellation has neither, so its terminal run-event row
 * is the only visible signal.
 *
 * Matched by `kind` (not `status`) on purpose: `tool.failed` is also
 * `status: 'failed'`, and re-surfacing it here would double-report its card.
 *
 * `tool.resume.unsupported` (BST-558) IS included — the first `tool.*` kind
 * here, and the one place the "already carded" premise does not apply. The card
 * DOES settle (the mapper emits an error `toolCallResult`, so a dismissed notice
 * cannot strand a Running spinner), but it reports a CLIENT capability error for
 * that one call. This row reports something different and thread-level: the RUN
 * is still suspended and this build cannot answer it. The transient
 * `brainstrike.tool-suspend` notice that would otherwise say so is `aui-data` —
 * gone after a reload — leaving this row the only surviving explanation.
 *
 * Because it is a `tool.*` kind carrying a `toolCallId`, and the mapper always
 * emits a `tool-call` part for that id, `resolveAssistantRunEventRenderPlan` and
 * `initialRenderPlanKey` BOTH exempt the always-visible kinds from their
 * card-suppression rule. Without that exemption this predicate would only pick
 * the code path, never the outcome, and the row would render at no detail level
 * at all (review of PR #1977). `run.failed`/`run.cancelled` never needed the
 * exemption: they carry no `toolCallId` and are not `tool.*`.
 */
export function isAlwaysVisibleRunEvent(data: unknown): boolean {
  const event = readAssistantRunEvent(data);
  if (!event) {
    return false;
  }
  return (
    event.kind === 'run.failed' ||
    event.kind === 'run.cancelled' ||
    event.kind === UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND
  );
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
  return readAssistantRunEventDataPart(part) ?? null;
}

function getRunEventsFromMessages(messages: readonly unknown[]): AssistantRunEvent[] {
  return messages.flatMap((message) =>
    getMessageParts(message)
      .map(getRunEventFromPart)
      .filter((event) => event !== null)
  );
}

export interface AssistantRunEventRows {
  readonly renderPlanKeys: Record<string, string>;
  readonly statuses: Record<string, AssistantRunEventStatus>;
}

interface RunEventIndex {
  readonly allByKind: Map<string, number>;
  readonly byKindAndRun: Map<string, number>;
  readonly byKindAndTool: Map<string, number>;
  readonly byKindRunAndTool: Map<string, number>;
  readonly withoutRunByKind: Map<string, number>;
  readonly withoutRunByKindAndTool: Map<string, number>;
}

function runKey(kind: string, runId: string): string {
  return `${kind}\u0000${runId}`;
}

function toolKey(kind: string, toolCallId: string): string {
  return `${kind}\u0000${toolCallId}`;
}

function runToolKey(kind: string, runId: string, toolCallId: string): string {
  return `${kind}\u0000${runId}\u0000${toolCallId}`;
}

function nextMatchingEventIndex(
  index: RunEventIndex,
  kind: string,
  event: AssistantRunEvent,
  matchTool: boolean
): number {
  const toolCallId = matchTool ? event.metadata?.['toolCallId'] : undefined;
  const hasToolScope = typeof toolCallId === 'string';
  const runId = event.runId;

  if (!runId) {
    return (
      (hasToolScope
        ? index.byKindAndTool.get(toolKey(kind, toolCallId))
        : index.allByKind.get(kind)) ?? Number.POSITIVE_INFINITY
    );
  }

  const sameRun = hasToolScope
    ? index.byKindRunAndTool.get(runToolKey(kind, runId, toolCallId))
    : index.byKindAndRun.get(runKey(kind, runId));
  const withoutRun = hasToolScope
    ? index.withoutRunByKindAndTool.get(toolKey(kind, toolCallId))
    : index.withoutRunByKind.get(kind);
  return Math.min(sameRun ?? Number.POSITIVE_INFINITY, withoutRun ?? Number.POSITIVE_INFINITY);
}

function resolveIndexedRunEventStatus(
  event: AssistantRunEvent,
  index: RunEventIndex
): AssistantRunEventStatus {
  if (event.status !== 'running') {
    return event.status;
  }
  const completedKind = getMatchingCompletedKind(event.kind);
  const failedKind = getMatchingFailedKind(event.kind);
  if (!(completedKind || failedKind)) {
    return event.status;
  }

  const candidates: Array<{ index: number; status: AssistantRunEventStatus }> = [];
  if (completedKind) {
    candidates.push({
      index: nextMatchingEventIndex(index, completedKind, event, event.kind === 'tool.started'),
      status: 'completed',
    });
  }
  if (failedKind) {
    candidates.push({
      index: nextMatchingEventIndex(index, failedKind, event, event.kind === 'tool.started'),
      status: 'failed',
    });
  }
  candidates.push(
    {
      index: nextMatchingEventIndex(index, 'run.failed', event, false),
      status: 'failed',
    },
    {
      index: nextMatchingEventIndex(index, 'run.cancelled', event, false),
      status: 'cancelled',
    }
  );
  if (event.kind !== 'run.started') {
    candidates.push({
      index: nextMatchingEventIndex(index, 'run.finished', event, false),
      status: 'completed',
    });
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.index === Number.POSITIVE_INFINITY
    ? event.status
    : (candidates[0]?.status ?? event.status);
}

function collectIndexedRunEvents(messages: readonly unknown[]): {
  events: AssistantRunEvent[];
  toolCallIds: Set<string>;
} {
  const events: AssistantRunEvent[] = [];
  const toolCallIds = new Set<string>();
  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      const event = getRunEventFromPart(part);
      if (event) {
        events.push(event);
        continue;
      }
      if (isRecord(part) && part['type'] === 'tool-call') {
        const toolCallId = part['toolCallId'];
        if (typeof toolCallId === 'string') {
          toolCallIds.add(toolCallId);
        }
      }
    }
  }
  return { events, toolCallIds };
}

function createRunEventIndex(): RunEventIndex {
  return {
    allByKind: new Map(),
    byKindAndRun: new Map(),
    byKindAndTool: new Map(),
    byKindRunAndTool: new Map(),
    withoutRunByKind: new Map(),
    withoutRunByKindAndTool: new Map(),
  };
}

function addFutureRunEvent(
  index: RunEventIndex,
  event: AssistantRunEvent,
  eventIndex: number
): void {
  index.allByKind.set(event.kind, eventIndex);
  const toolCallId = event.metadata?.['toolCallId'];
  if (typeof toolCallId === 'string') {
    index.byKindAndTool.set(toolKey(event.kind, toolCallId), eventIndex);
  }
  if (event.runId) {
    index.byKindAndRun.set(runKey(event.kind, event.runId), eventIndex);
    if (typeof toolCallId === 'string') {
      index.byKindRunAndTool.set(runToolKey(event.kind, event.runId, toolCallId), eventIndex);
    }
    return;
  }
  index.withoutRunByKind.set(event.kind, eventIndex);
  if (typeof toolCallId === 'string') {
    index.withoutRunByKindAndTool.set(toolKey(event.kind, toolCallId), eventIndex);
  }
}

function hasIndexedTerminalEvent(event: AssistantRunEvent, index: RunEventIndex): boolean {
  if (!event.kind.endsWith('.started')) {
    return false;
  }
  const matchTool = event.kind === 'tool.started';
  const completedKind = getMatchingCompletedKind(event.kind);
  const failedKind = getMatchingFailedKind(event.kind);
  const completedIndex = completedKind
    ? nextMatchingEventIndex(index, completedKind, event, matchTool)
    : Number.POSITIVE_INFINITY;
  const failedIndex = failedKind
    ? nextMatchingEventIndex(index, failedKind, event, matchTool)
    : Number.POSITIVE_INFINITY;
  return Number.isFinite(Math.min(completedIndex, failedIndex));
}

function initialRenderPlanKey(
  event: AssistantRunEvent,
  index: RunEventIndex,
  toolCallIds: ReadonlySet<string>
): string {
  const toolCallId = event.metadata?.['toolCallId'];
  // Mirrors `resolveAssistantRunEventRenderPlan`'s card-suppression rule,
  // INCLUDING its always-visible exemption — the two paths must agree, or the
  // Developer level hides a row the default level shows.
  const hasToolCard =
    !isAlwaysVisibleRunEvent(event) &&
    event.kind.startsWith('tool.') &&
    typeof toolCallId === 'string' &&
    toolCallIds.has(toolCallId);
  return event.kind.startsWith('subagent.') || hasToolCard || hasIndexedTerminalEvent(event, index)
    ? 'hidden'
    : 'visible:1';
}

function applyRepeatedEventPlans(
  events: readonly AssistantRunEvent[],
  renderPlanKeys: Record<string, string>
): void {
  for (let start = 0; start < events.length; ) {
    const first = events[start];
    if (!first) {
      return;
    }
    let end = start + 1;
    while (end < events.length && isSameRunEventContent(first, events[end] as AssistantRunEvent)) {
      end += 1;
    }
    if (renderPlanKeys[first.id] !== 'hidden' && end - start > 1) {
      renderPlanKeys[first.id] = `visible:${end - start}`;
      for (let duplicate = start + 1; duplicate < end; duplicate += 1) {
        const duplicateEvent = events[duplicate];
        if (duplicateEvent) {
          renderPlanKeys[duplicateEvent.id] = 'hidden';
        }
      }
    }
    start = end;
  }
}

/**
 * One thread-wide derivation for every run-event row. Message parts are read
 * exactly once; indexed terminal lookups replace each row's former full-thread
 * status/render-plan scans.
 */
export function deriveAssistantRunEventRows(messages: readonly unknown[]): AssistantRunEventRows {
  const { events, toolCallIds } = collectIndexedRunEvents(messages);
  const futureEvents = createRunEventIndex();
  const statusByIndex: Array<AssistantRunEventStatus | undefined> = [];
  const planByIndex: Array<string | undefined> = [];
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex];
    if (!event) {
      continue;
    }
    statusByIndex[eventIndex] = resolveIndexedRunEventStatus(event, futureEvents);
    planByIndex[eventIndex] = initialRenderPlanKey(event, futureEvents, toolCallIds);
    addFutureRunEvent(futureEvents, event, eventIndex);
  }

  const renderPlanKeys: Record<string, string> = {};
  const statuses: Record<string, AssistantRunEventStatus> = {};
  for (const [eventIndex, event] of events.entries()) {
    if (statuses[event.id] !== undefined) {
      continue;
    }
    statuses[event.id] = statusByIndex[eventIndex] ?? event.status;
    renderPlanKeys[event.id] = planByIndex[eventIndex] ?? 'visible:1';
  }
  applyRepeatedEventPlans(events, renderPlanKeys);

  return { renderPlanKeys, statuses };
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
  if (kind === 'memory.observation.started') {
    // BST-947: an observation cycle can terminate in the durable
    // memory.observation.failed event; without this pairing a failed cycle
    // would leave the started row spinning forever.
    return 'memory.observation.failed';
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
  const event = readAssistantRunEvent(data) ?? null;
  if (!event) {
    return VISIBLE_ONCE;
  }
  // Subagent nested activity renders inside the SubagentExecutionCard, not the
  // main timeline — a per-nested-tool row here would duplicate the card. Match
  // the `subagent.` namespace precisely (never a bare `subagent`-prefixed word).
  if (event.kind.startsWith('subagent.')) {
    return HIDDEN;
  }
  // Card suppression exists so a `tool.*` row never double-reports a status the
  // ToolFallback card already owns. An always-visible kind is exempt: it is not
  // a status for that call (the card reports a CLIENT capability error; this row
  // explains why the RUN is still suspended), and the mapper guarantees the
  // suppressing `tool-call` part exists for exactly this `toolCallId` — so
  // without the exemption the row would be hidden at every detail level, which
  // is the opposite of what `isAlwaysVisibleRunEvent` means.
  if (!isAlwaysVisibleRunEvent(event) && hasToolCallPartForEvent(messages, event)) {
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
