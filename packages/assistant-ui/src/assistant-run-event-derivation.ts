import type {
  AssistantRunEvent,
  AssistantRunEventKind,
  AssistantRunEventStatus,
} from '@brainstrike/assistant-contract';
import {
  ASSISTANT_RUN_EVENT_KINDS,
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
 * `brainstrike.tool-suspend` notice that would otherwise say so is `aui-data`,
 * so it does not survive a reload on its own; since BST-1084
 * `appendSuspendedPauseMessages` re-appends it for pauses that are STILL
 * suspended, while this row is the record that outlives an answered one.
 *
 * Because it is a `tool.*` kind carrying a `toolCallId`, and the mapper always
 * emits a `tool-call` part for that id, `resolveAssistantRunEventRenderPlan` and
 * `initialRenderPlanKey` BOTH exempt the always-visible kinds from their
 * card-suppression rule. Without that exemption this predicate would only pick
 * the code path, never the outcome, and the row would render at no detail level
 * at all (review of PR #1977). `run.failed`/`run.cancelled` never needed the
 * exemption: they carry no `toolCallId` and are not `tool.*`.
 *
 * `tool.approval.requested` (BST-1402) is included and needs the SAME exemption,
 * for the same structural reason as BST-558's row (see the corrected note
 * above: neither notice is lost on reload). A still-pending pause does get its
 * actionable `brainstrike.tool-approval` notice back after a reload
 * (`listSuspendedMastraRuns` rediscovers the suspended snapshot), so this row is
 * not the only surviving evidence — but that notice is a synthetic message
 * appended at the END of the thread and exists ONLY while the pause is pending.
 * This row is the in-transcript record, at the point the run actually stopped
 * and asked, and the only one that survives the pause being answered. It is a
 * `tool.*` kind carrying the paused call's `toolCallId` and the mapper always
 * emits a `tool-call` part for that id, so without the exemption it would be
 * suppressed as "already carded" at every detail level.
 *
 * `mcp.tools.unavailable` (BST-1602) is included for the same reason and is the
 * cleanest case in this list: an MCP server contributed ZERO tools to the run,
 * so NOTHING cards it — the tool never entered the map, which is why
 * `search_tools` reports "0 results". The "Tool execution failed." card the user
 * does see belongs to the model's follow-up call on that missing tool and
 * reports the wrong cause. Like `run.failed`/`run.cancelled` it carries no
 * `toolCallId` and is not `tool.*`, so it needs no card-suppression exemption.
 * Membership here is load-bearing, not decorative: rows are hidden at default
 * detail, so a kind added to the contract alone would still report nothing to
 * the user it exists for.
 */
export function isAlwaysVisibleRunEvent(data: unknown): boolean {
  const event = readAssistantRunEvent(data);
  if (!event) {
    return false;
  }
  return (
    event.kind === 'mcp.tools.unavailable' ||
    event.kind === 'run.failed' ||
    event.kind === 'run.cancelled' ||
    event.kind === 'tool.approval.requested' ||
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
  readonly byKindAndScope: Map<string, number>;
  readonly byKindRunAndScope: Map<string, number>;
  readonly withoutRunByKind: Map<string, number>;
  readonly withoutRunByKindAndScope: Map<string, number>;
}

/**
 * Metadata keys that identify WHICH in-flight thing an event belongs to. Every
 * event is indexed under each key it carries; a `.started` row then matches
 * terminals through the ONE key `scopeMetadataKey` picks for its kind.
 */
const SCOPE_METADATA_KEYS = ['toolCallId', 'parentToolCallId'] as const;

/**
 * The metadata key scoping a `.started` row to its OWN terminal, or null when
 * the kind is a per-run singleton that needs no scoping.
 *
 * `subagent.started` scopes on `parentToolCallId`: subagent LIFECYCLE events
 * carry no `toolCallId` of their own (`makeSubagentLifecycleChunk` emits
 * `personaId`/`toolName`/`parentToolCallId`), and up to
 * `MAX_CONCURRENT_DELEGATIONS` (2) delegations are in flight at once — unscoped,
 * the first `subagent.finished` in the run would close out EVERY open
 * delegation row, reporting one delegation's outcome on another's. Nested
 * `subagent.tool.started` scopes on its own child `toolCallId`, which
 * `mapDelegationToolOutput` puts on the started AND terminal chunks.
 */
function scopeMetadataKey(kind: AssistantRunEventKind): string | null {
  if (
    kind === 'tool.started' ||
    kind === 'subagent.tool.started' ||
    kind === 'tool.approval.requested'
  ) {
    return 'toolCallId';
  }
  if (kind === 'subagent.started') {
    return 'parentToolCallId';
  }
  return null;
}

function runKey(kind: string, runId: string): string {
  return `${kind}\u0000${runId}`;
}

function scopeKey(kind: string, metadataKey: string, scopeId: string): string {
  return `${kind}\u0000${metadataKey}\u0000${scopeId}`;
}

function runScopeKey(kind: string, runId: string, metadataKey: string, scopeId: string): string {
  return `${kind}\u0000${runId}\u0000${metadataKey}\u0000${scopeId}`;
}

function nextMatchingEventIndex(
  index: RunEventIndex,
  kind: string,
  event: AssistantRunEvent,
  metadataKey: string | null
): number {
  const scopeId = metadataKey === null ? undefined : event.metadata?.[metadataKey];
  const scoped = metadataKey !== null && typeof scopeId === 'string';
  const runId = event.runId;

  // Run-AGNOSTIC lookup for kinds whose durable identity is the `toolCallId`
  // (see `isRunAgnosticTerminalKind`): the answering terminal legitimately
  // carries a DIFFERENT runId, so the run-scoped buckets below can never find
  // it. `byKindAndScope` indexes every event carrying the scope key regardless
  // of runId, which is exactly the pairing wanted here.
  if (scoped && isRunAgnosticTerminalKind(event.kind)) {
    return (
      index.byKindAndScope.get(scopeKey(kind, metadataKey, scopeId)) ?? Number.POSITIVE_INFINITY
    );
  }

  if (!runId) {
    return (
      (scoped
        ? index.byKindAndScope.get(scopeKey(kind, metadataKey, scopeId))
        : index.allByKind.get(kind)) ?? Number.POSITIVE_INFINITY
    );
  }

  const sameRun = scoped
    ? index.byKindRunAndScope.get(runScopeKey(kind, runId, metadataKey, scopeId))
    : index.byKindAndRun.get(runKey(kind, runId));
  const withoutRun = scoped
    ? index.withoutRunByKindAndScope.get(scopeKey(kind, metadataKey, scopeId))
    : index.withoutRunByKind.get(kind);
  return Math.min(sameRun ?? Number.POSITIVE_INFINITY, withoutRun ?? Number.POSITIVE_INFINITY);
}

function resolveIndexedRunEventStatus(
  event: AssistantRunEvent,
  index: RunEventIndex,
  events: readonly AssistantRunEvent[]
): AssistantRunEventStatus {
  if (event.status !== 'running') {
    return event.status;
  }
  const terminalKinds = getTerminalKinds(event.kind);
  if (terminalKinds.length === 0) {
    return event.status;
  }

  const metadataKey = scopeMetadataKey(event.kind);
  const candidates = terminalKinds.map((terminalKind) =>
    nextMatchingEventIndex(index, terminalKind, event, metadataKey)
  );
  candidates.push(
    nextMatchingEventIndex(index, 'run.failed', event, null),
    nextMatchingEventIndex(index, 'run.cancelled', event, null)
  );
  if (event.kind !== 'run.started') {
    candidates.push(nextMatchingEventIndex(index, 'run.finished', event, null));
  }
  const winner = Math.min(...candidates);
  // The winning TERMINAL's own status, never one derived from its kind: an
  // aborted or declined delegation's terminal is `subagent.failed` carrying
  // status 'cancelled', and a kind-derived 'failed' would misreport it. Every
  // other pairing is unchanged — terminals carry the status their kind implies.
  return events[winner]?.status ?? event.status;
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
    byKindAndScope: new Map(),
    byKindRunAndScope: new Map(),
    withoutRunByKind: new Map(),
    withoutRunByKindAndScope: new Map(),
  };
}

function addFutureRunEvent(
  index: RunEventIndex,
  event: AssistantRunEvent,
  eventIndex: number
): void {
  index.allByKind.set(event.kind, eventIndex);
  const runId = event.runId;
  if (runId) {
    index.byKindAndRun.set(runKey(event.kind, runId), eventIndex);
  } else {
    index.withoutRunByKind.set(event.kind, eventIndex);
  }
  for (const metadataKey of SCOPE_METADATA_KEYS) {
    const scopeId = event.metadata?.[metadataKey];
    if (typeof scopeId !== 'string') {
      continue;
    }
    index.byKindAndScope.set(scopeKey(event.kind, metadataKey, scopeId), eventIndex);
    if (runId) {
      index.byKindRunAndScope.set(runScopeKey(event.kind, runId, metadataKey, scopeId), eventIndex);
      continue;
    }
    index.withoutRunByKindAndScope.set(scopeKey(event.kind, metadataKey, scopeId), eventIndex);
  }
}

function hasIndexedTerminalEvent(event: AssistantRunEvent, index: RunEventIndex): boolean {
  if (!event.kind.endsWith('.started')) {
    return false;
  }
  const metadataKey = scopeMetadataKey(event.kind);
  const completedKind = getMatchingCompletedKind(event.kind);
  const failedKind = getMatchingFailedKind(event.kind);
  const completedIndex = completedKind
    ? nextMatchingEventIndex(index, completedKind, event, metadataKey)
    : Number.POSITIVE_INFINITY;
  const failedIndex = failedKind
    ? nextMatchingEventIndex(index, failedKind, event, metadataKey)
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
    statusByIndex[eventIndex] = resolveIndexedRunEventStatus(event, futureEvents, events);
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

const RUN_EVENT_KINDS: ReadonlySet<string> = new Set(ASSISTANT_RUN_EVENT_KINDS);

const STARTED_SUFFIX = '.started';

/**
 * Success terminals are spelled `.finished` in some namespaces (`run.started`,
 * `run.step.started`, `subagent.started`) and `.completed` in others
 * (`tool.started`, `memory.*.started`, `subagent.tool.started`). Both spellings
 * are tried and the ONE the contract actually declares wins.
 */
const COMPLETED_SUFFIXES = ['.completed', '.finished'] as const;

/** Not every `.started` kind has a failure terminal; only some namespaces emit one. */
const FAILED_SUFFIXES = ['.failed'] as const;

function isRunEventKind(value: string): value is AssistantRunEventKind {
  return RUN_EVENT_KINDS.has(value);
}

/**
 * Terminal counterpart of a `.started` kind, resolved against
 * `ASSISTANT_RUN_EVENT_KINDS` rather than by string rewriting: a candidate only
 * pairs when the contract declares it, so this can never name a kind nothing
 * emits. That was the `subagent.started` bug — a `.started` → `.completed`
 * rewrite produced `subagent.completed`, which is not a declared kind and never
 * arrives (the real terminals are `subagent.finished` / `subagent.failed`), so
 * the row could only ever resolve through the generic end-of-run fallbacks. It
 * was invisible because `subagent.*` rows are hidden from the timeline entirely
 * (they render inside the SubagentExecutionCard).
 *
 * BST-947 rationale still applies to the `.failed` side: an observation cycle
 * can terminate in the durable `memory.observation.failed` event, and without
 * that pairing a failed cycle leaves its started row spinning forever.
 */
function resolveTerminalKind(
  kind: AssistantRunEventKind,
  suffixes: readonly string[]
): AssistantRunEventKind | null {
  if (!kind.endsWith(STARTED_SUFFIX)) {
    return null;
  }
  const stem = kind.slice(0, -STARTED_SUFFIX.length);
  for (const suffix of suffixes) {
    const candidate = `${stem}${suffix}`;
    if (isRunEventKind(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getMatchingCompletedKind(
  kind: AssistantRunEventKind
): AssistantRunEventKind | null {
  return resolveTerminalKind(kind, COMPLETED_SUFFIXES);
}

export function getMatchingFailedKind(kind: AssistantRunEventKind): AssistantRunEventKind | null {
  return resolveTerminalKind(kind, FAILED_SUFFIXES);
}

/**
 * Terminals for `running` kinds that are deliberately NOT `.started` kinds, and
 * so get nothing from the suffix pairing above.
 *
 * `tool.approval.requested` (BST-1402) is the only one: the approval pause is
 * not a lifecycle start (no tool ran — see the contract), yet it IS `running`,
 * and a `running` row with no terminal spins for the whole thread. It closes out
 * on the same `toolCallId`'s next OUTCOME — approve => the resumed stream runs
 * the tool and emits `tool.completed`, decline => `tool.failed` ("Tool call
 * declined"), no registered resume UI => `tool.resume.unsupported`.
 *
 * `tool.started` is deliberately absent: it carries status `running`, so the
 * nearest-terminal-wins lookup would "resolve" the pause to the status it
 * already had AND would report a still-executing tool as an answered pause.
 * The `tool.completed`/`tool.failed` that follow it are the real answers.
 */
const EXPLICIT_TERMINAL_KINDS: Partial<
  Record<AssistantRunEventKind, readonly AssistantRunEventKind[]>
> = {
  'tool.approval.requested': ['tool.completed', 'tool.failed', 'tool.resume.unsupported'],
};

/**
 * True when this kind's terminals must be matched WITHOUT comparing `runId`,
 * on `toolCallId` alone.
 *
 * WHY: an approval pause is answered by a SEPARATE resume leg, and that leg
 * mints its own runId and its own `thread_runs` row (`prepareRequestData` calls
 * the single `createThreadRunId` producer per leg; `stream-init` opens a run
 * row for it). The
 * paused leg meanwhile emits NO run terminal at all — it returns `finished`
 * at the pause and desktop only UPDATEs `thread_runs.status`. So the pause row
 * carries run A while the `tool.completed` / `tool.failed` that answers it
 * carries run B, and a run-scoped pairing can never close it. Live streaming
 * hid this because live run-event parts carry no `runId`; hydrated parts carry
 * the persisted one, so every RELOADED thread that ever contained an approval
 * would render a permanent "Awaiting your approval" spinner — including
 * long-answered ones.
 *
 * `toolCallId` is globally unique per call, which is exactly why it is this
 * kind's scope key: it is the durable identity of the thing being answered,
 * and the run is not. Scoping is NOT dropped — a terminal for any other
 * `toolCallId` still cannot close this row.
 *
 * Deliberately narrow: only kinds that declare an EXPLICIT terminal list AND
 * scope on `toolCallId`. Every `.started` kind keeps run-scoped matching, and
 * so do the generic `run.failed` / `run.cancelled` / `run.finished` fallbacks
 * (they are per-run facts, not per-call ones).
 */
function isRunAgnosticTerminalKind(kind: AssistantRunEventKind): boolean {
  return EXPLICIT_TERMINAL_KINDS[kind] !== undefined && scopeMetadataKey(kind) === 'toolCallId';
}

/**
 * Every terminal kind that can close a `running` row: the explicit list when the
 * kind declares one, otherwise its suffix-derived completed/failed pair. Empty
 * means the row has no terminal of its own and only the generic end-of-run
 * fallbacks apply.
 */
export function getTerminalKinds(kind: AssistantRunEventKind): readonly AssistantRunEventKind[] {
  const explicit = EXPLICIT_TERMINAL_KINDS[kind];
  if (explicit) {
    return explicit;
  }
  const completed = getMatchingCompletedKind(kind);
  const failed = getMatchingFailedKind(kind);
  return [completed, failed].filter((terminal): terminal is AssistantRunEventKind =>
    Boolean(terminal)
  );
}

function hasSameScope(event: AssistantRunEvent, candidate: AssistantRunEvent): boolean {
  const metadataKey = scopeMetadataKey(event.kind);
  if (metadataKey === null) {
    return true;
  }
  const scopeId = event.metadata?.[metadataKey];
  return typeof scopeId !== 'string' || candidate.metadata?.[metadataKey] === scopeId;
}

function resolveFromLaterRunEvent(
  event: AssistantRunEvent,
  candidate: AssistantRunEvent,
  terminalKinds: readonly AssistantRunEventKind[]
): AssistantRunEventStatus | null {
  // Mirrors the indexed path: the matched TERMINAL's own status, never a status
  // derived from its kind (an aborted or declined delegation's `subagent.failed`
  // carries 'cancelled'), and scoped so a terminal only closes its own row.
  // `isRunAgnosticTerminalKind` skips the run check for kinds answered by a
  // separate resume leg — see its comment; every other kind stays run-scoped.
  if (
    terminalKinds.includes(candidate.kind) &&
    hasSameScope(event, candidate) &&
    (isRunAgnosticTerminalKind(event.kind) || hasSameRunScope(event, candidate))
  ) {
    return candidate.status;
  }
  if (!hasSameRunScope(event, candidate)) {
    return null;
  }
  if (candidate.kind === 'run.failed' || candidate.kind === 'run.cancelled') {
    return candidate.status;
  }
  if (event.kind !== 'run.started' && candidate.kind === 'run.finished') {
    return candidate.status;
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
        hasSameScope(event, candidate)
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
  // ToolFallback card already owns. Every always-visible kind is exempt,
  // because none of them IS a status for that call — they report a
  // thread-level fact the card cannot: that the run is suspended and this build
  // cannot answer it (`tool.resume.unsupported`), or that the run stopped and
  // asked the user (`tool.approval.requested`). The mapper guarantees the
  // suppressing `tool-call` part exists for exactly these `toolCallId`s, so
  // without the exemption those rows would be hidden at EVERY detail level,
  // which is the opposite of what `isAlwaysVisibleRunEvent` means.
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

  const terminalKinds = getTerminalKinds(event.kind);
  if (terminalKinds.length === 0) {
    return event.status;
  }

  const runEvents = getRunEventsFromMessages(messages);
  const eventIndex = runEvents.findIndex((candidate) => candidate.id === event.id);
  const laterEvents = eventIndex >= 0 ? runEvents.slice(eventIndex + 1) : runEvents;

  for (const candidate of laterEvents) {
    const resolvedStatus = resolveFromLaterRunEvent(event, candidate, terminalKinds);
    if (resolvedStatus) {
      return resolvedStatus;
    }
  }

  return event.status;
}
