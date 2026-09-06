import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';
import type { AssistantRunEvent } from '@brainstrike/assistant-contract/run-events';
import {
  type RediscoveredToolApproval,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  type RediscoveredToolSuspend,
  TOOL_SUSPEND_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-suspend';
import type {
  AssistantHistoryLoadResult,
  AssistantHistoryRepositoryMessages,
  AssistantHistoryToolCallPart,
  AssistantHydratedContentPart,
  AssistantRunEventDataPart,
  AssistantToolResultSnapshot,
  TimedHistoryContentPart,
} from './assistant-history-content.js';
import {
  collectToolResults,
  readContentPartArray,
  toAssistantHistoryContentParts,
  toTextHistoryContentParts,
} from './assistant-history-content.js';
import { toRunEventDataParts } from './assistant-thread-rows.js';
import type { AssistantHistoryMessage } from './assistant-thread-types.js';
import { isRecord } from './assistant-value-coercion.js';

/**
 * A run of assistant snapshot rows for one branch identity. User/system rows
 * and a new topology-bearing assistant ID split groups; legacy `role: 'tool'`
 * rows do not. Observational-memory sealing and per-step saves split ONE live
 * assistant turn into several rows, so a group hydrates back into a single
 * assistant-ui message — matching what the thread looked like while it streamed.
 */
interface AssistantHistoryRowGroup {
  readonly kind: 'assistant-group';
  readonly parts: TimedHistoryContentPart[];
  readonly rows: AssistantHistoryMessage[];
}

interface AssistantHistorySingleUnit {
  readonly kind: 'user' | 'system';
  readonly message: AssistantHistoryMessage;
}

type AssistantHistoryUnit = AssistantHistoryRowGroup | AssistantHistorySingleUnit;

function runEventTimeMs(eventPart: AssistantRunEventDataPart): number {
  const ms = Date.parse(eventPart.data.timestamp);
  // Unparseable timestamps surface at the front of the group (the legacy
  // prepend position) instead of being dropped.
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Tool-invocation parts rarely carry their own persisted timestamp, but every
 * tool execution emits a `tool.started` run event whose metadata names the
 * toolCallId — re-time each tool-call part to its own start event so reloaded
 * calls sit exactly where they executed instead of clumping at a snapshot
 * boundary.
 */
function applyToolEventTimes(
  parts: readonly TimedHistoryContentPart[],
  eventParts: readonly AssistantRunEventDataPart[]
): readonly TimedHistoryContentPart[] {
  const startTimesByToolCallId = new Map<string, number>();
  for (const eventPart of eventParts) {
    if (eventPart.data.kind !== 'tool.started') {
      continue;
    }
    const toolCallId = eventPart.data.metadata?.['toolCallId'];
    if (typeof toolCallId !== 'string' || startTimesByToolCallId.has(toolCallId)) {
      continue;
    }
    const ms = Date.parse(eventPart.data.timestamp);
    if (!Number.isNaN(ms)) {
      startTimesByToolCallId.set(toolCallId, ms);
    }
  }
  if (startTimesByToolCallId.size === 0) {
    return parts;
  }
  return parts.map((timed) => {
    if (timed.part.type !== 'tool-call') {
      return timed;
    }
    const ms = startTimesByToolCallId.get(timed.part.toolCallId);
    return ms === undefined ? timed : { at: ms, part: timed.part };
  });
}

/**
 * Interleave run events with content parts in live order: each event is
 * emitted before the first content part produced after it. Parts without a
 * persisted timestamp inherit the previous part's moment, so relative content
 * order is never changed.
 */
function weaveRunEventsIntoContent(
  parts: readonly TimedHistoryContentPart[],
  eventParts: readonly AssistantRunEventDataPart[],
  groupStartMs: number
): Array<AssistantHydratedContentPart | AssistantRunEventDataPart> {
  if (eventParts.length === 0) {
    return parts.map((timed) => timed.part);
  }
  const woven: Array<AssistantHydratedContentPart | AssistantRunEventDataPart> = [];
  let eventIndex = 0;
  let lastAt = groupStartMs;
  for (const timed of parts) {
    const at = timed.at ?? lastAt;
    lastAt = at;
    while (eventIndex < eventParts.length) {
      const eventPart = eventParts[eventIndex];
      if (!eventPart || runEventTimeMs(eventPart) > at) {
        break;
      }
      woven.push(eventPart);
      eventIndex += 1;
    }
    woven.push(timed.part);
  }
  for (; eventIndex < eventParts.length; eventIndex += 1) {
    const eventPart = eventParts[eventIndex];
    if (eventPart) {
      woven.push(eventPart);
    }
  }
  return woven;
}

/** Preserve Mastra v2 `content.metadata.custom` across renderer hydration. */
function readHistoryCustomMetadata(content: unknown): Record<string, unknown> {
  if (!isRecord(content)) {
    return {};
  }
  const metadata = content['metadata'];
  if (!isRecord(metadata)) {
    return {};
  }
  const custom = metadata['custom'];
  return isRecord(custom) ? { ...custom } : {};
}

function appendAssistantGroupMessage(args: {
  group: AssistantHistoryRowGroup;
  groupEventParts: readonly AssistantRunEventDataPart[];
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): string | null {
  const firstRow = args.group.rows.at(0);
  const lastRow = args.group.rows.at(-1);
  if (!(firstRow && lastRow)) {
    return null;
  }
  // A group with no renderable parts of its own is still appended when it
  // carries run events — otherwise the persisted execution path would be
  // invisible after reload.
  if (args.group.parts.length === 0 && args.groupEventParts.length === 0) {
    return null;
  }
  const content = weaveRunEventsIntoContent(
    applyToolEventTimes(args.group.parts, args.groupEventParts),
    args.groupEventParts,
    firstRow.createdAt.getTime()
  );
  const topologyRows = args.group.rows.filter((row) => row.parentId !== undefined);
  const messageId = topologyRows.at(0)?.id ?? lastRow.id;
  if (topologyRows.some((row) => row.id !== messageId)) {
    throw new Error(`Assistant message snapshots disagree on branch identity for ${lastRow.id}.`);
  }
  args.repositoryMessages.push({
    message: {
      content,
      createdAt: firstRow.createdAt,
      id: messageId,
      metadata: {
        custom: readHistoryCustomMetadata(lastRow.content),
        steps: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_annotations: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_data: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_state: null,
      },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    },
    parentId: args.parentId,
  });
  return messageId;
}

function resolveAssistantGroupParentId(
  group: AssistantHistoryRowGroup,
  legacyParentId: string | null
): string | null {
  let resolvedParentId: string | null | undefined;
  for (const row of group.rows) {
    if (row.parentId === undefined) {
      continue;
    }
    if (resolvedParentId === undefined) {
      resolvedParentId = row.parentId;
      continue;
    }
    if (resolvedParentId !== row.parentId) {
      throw new Error(`Assistant message snapshots disagree on branch parent for ${row.id}.`);
    }
  }
  return resolvedParentId === undefined ? legacyParentId : resolvedParentId;
}

type AssistantHistoryUserMessage = Extract<
  AssistantHistoryRepositoryMessages[number]['message'],
  { role: 'user' }
>;

type AssistantHistoryUserAttachment = AssistantHistoryUserMessage['attachments'][number];

/**
 * Rebuild composer image attachments from the persisted Mastra v2 FILE
 * dialect: `{ type: 'file', data: <base64 data URL>, mimeType: 'image/…' }`
 * parts (the shape pinned by the packages/agent persistence spec — note
 * `mimeType`, not `mediaType`). Hydrated attachments render through the same
 * `MessagePrimitive.Attachments` strip as live sends, and their content is
 * re-merged into the outbound message on later turns so the model keeps
 * seeing the image after a reload.
 */
function toUserHistoryAttachments(
  messageId: string,
  value: unknown
): AssistantHistoryUserAttachment[] {
  const rawParts = readContentPartArray(value);
  if (!rawParts) {
    return [];
  }
  const attachments: AssistantHistoryUserAttachment[] = [];
  for (const raw of rawParts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (record['type'] !== 'file') {
      continue;
    }
    const data = record['data'];
    const mimeType = record['mimeType'];
    if (typeof data !== 'string' || typeof mimeType !== 'string') {
      continue;
    }
    // v1 attachments are images only; a non-image file part is not renderable
    // attachment state (and never produced by the composer adapter).
    const normalizedMimeType = mimeType.toLowerCase();
    if (!normalizedMimeType.startsWith('image/')) {
      continue;
    }
    const index = attachments.length + 1;
    const subtype = normalizedMimeType.slice('image/'.length) || 'png';
    attachments.push({
      content: [{ image: data, type: 'image' }],
      contentType: mimeType,
      id: `${messageId}-attachment-${index}`,
      name: `image-${index}.${subtype}`,
      status: { type: 'complete' },
      type: 'image',
    });
  }
  return attachments;
}

function appendUserHistoryMessage(args: {
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): boolean {
  const content = toTextHistoryContentParts(args.message.content);
  const attachments = toUserHistoryAttachments(args.message.id, args.message.content);
  // An image-only user message has no text part but must survive hydration.
  if (content.length === 0 && attachments.length === 0) {
    return false;
  }

  args.repositoryMessages.push({
    message: {
      attachments,
      content,
      createdAt: args.message.createdAt,
      id: args.message.id,
      metadata: { custom: {} },
      role: 'user',
    },
    parentId: args.parentId,
  });
  return true;
}

function appendSystemHistoryMessage(args: {
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): boolean {
  const textPart = toTextHistoryContentParts(args.message.content).at(0);
  if (!textPart) {
    return false;
  }

  args.repositoryMessages.push({
    message: {
      content: [textPart],
      createdAt: args.message.createdAt,
      id: args.message.id,
      metadata: { custom: {} },
      role: 'system',
    },
    parentId: args.parentId,
  });
  return true;
}

/**
 * Partition the row stream into units: user/system rows stand alone;
 * assistant snapshot rows with one topology identity collapse into one group
 * (legacy `role: 'tool'` rows neither render nor break a group). A second
 * topology-bearing assistant ID starts a regenerated sibling group even when
 * no user row separates the persisted responses. Conversion happens here
 * exactly once per row, in chronological order — the tool-call dedupe map is
 * stateful (it keeps the FIRST occurrence of each toolCallId across snapshot
 * rows), so re-converting a row would corrupt it.
 */
function buildHistoryUnits(
  messages: readonly AssistantHistoryMessage[],
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHistoryUnit[] {
  const units: AssistantHistoryUnit[] = [];
  const seenToolCallsById = new Map<string, AssistantHistoryToolCallPart>();
  let openGroup: {
    parts: TimedHistoryContentPart[];
    rows: AssistantHistoryMessage[];
    topologyMessageId?: string;
  } | null = null;

  const closeOpenGroup = (): void => {
    if (!openGroup) {
      return;
    }
    units.push({ kind: 'assistant-group', parts: openGroup.parts, rows: openGroup.rows });
    openGroup = null;
  };

  for (const message of messages) {
    if (message.role === 'assistant') {
      const topologyMessageId = message.parentId === undefined ? undefined : message.id;
      if (
        topologyMessageId !== undefined &&
        openGroup !== null &&
        openGroup.topologyMessageId !== topologyMessageId
      ) {
        closeOpenGroup();
      }
      openGroup ??= { parts: [], rows: [] };
      if (topologyMessageId !== undefined) {
        openGroup.topologyMessageId = topologyMessageId;
      }
      openGroup.rows.push(message);
      // Parts without a persisted timestamp anchor to their snapshot row's
      // save time — each row seals shortly after its parts were produced.
      const rowMs = message.createdAt.getTime();
      openGroup.parts.push(
        ...toAssistantHistoryContentParts(
          message.content,
          toolResultsByCallId,
          seenToolCallsById
        ).map((timed) => (timed.at === undefined ? { at: rowMs, part: timed.part } : timed))
      );
      continue;
    }
    if (message.role === 'user' || message.role === 'system') {
      closeOpenGroup();
      units.push({ kind: message.role, message });
    }
    // Other roles (legacy 'tool' rows) are folded into tool results and never
    // rendered — they intentionally do not split an assistant group.
  }
  closeOpenGroup();
  return units;
}

/**
 * Assign each persisted run back to its own assistant group. A run's earliest
 * events occur before its first assistant row is saved, while the next run's
 * events form the upper boundary. Choosing the newest unassigned group inside
 * each run window preserves older turns and also avoids attaching a current
 * run's early memory/tool events to the previous turn.
 */
function assignRunEventsToGroups(
  units: readonly AssistantHistoryUnit[],
  runEvents: readonly AssistantRunEvent[]
): Map<AssistantHistoryUnit, AssistantRunEventDataPart[]> {
  const assignments = new Map<AssistantHistoryUnit, AssistantRunEventDataPart[]>();
  const assistantGroups = units.filter(
    (unit): unit is AssistantHistoryRowGroup => unit.kind === 'assistant-group'
  );
  if (assistantGroups.length === 0 || runEvents.length === 0) {
    return assignments;
  }

  const eventsByRunId = new Map<string, AssistantRunEvent[]>();
  for (const event of runEvents) {
    const runId = event.runId;
    if (!runId) {
      continue;
    }
    const runEventsForId = eventsByRunId.get(runId);
    if (runEventsForId) {
      runEventsForId.push(event);
    } else {
      eventsByRunId.set(runId, [event]);
    }
  }
  const runs = [...eventsByRunId.values()]
    .map((events) => ({
      events: events.sort(
        (left, right) =>
          (left.sequence ?? 0) - (right.sequence ?? 0) ||
          Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
          left.id.localeCompare(right.id)
      ),
      startedAt: Math.min(...events.map((event) => Date.parse(event.timestamp))),
    }))
    .filter((run) => Number.isFinite(run.startedAt))
    .sort((left, right) => left.startedAt - right.startedAt);
  const unassignedGroups = new Set(assistantGroups);

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    if (!run) {
      continue;
    }
    const nextRunStartedAt = runs[runIndex + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
    const candidate = assistantGroups.findLast((group) => {
      const firstRow = group.rows.at(0);
      return (
        unassignedGroups.has(group) &&
        firstRow !== undefined &&
        firstRow.createdAt.getTime() < nextRunStartedAt
      );
    });
    if (!candidate) {
      continue;
    }
    assignments.set(candidate, toRunEventDataParts(run.events));
    unassignedGroups.delete(candidate);
  }
  return assignments;
}

function historyMessagePartTimeRange(content: unknown): { first: number; last: number } | null {
  const parts = readContentPartArray(content);
  if (!parts) {
    return null;
  }
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const createdAt = (part as Record<string, unknown>)['createdAt'];
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
      continue;
    }
    first = Math.min(first, createdAt);
    last = Math.max(last, createdAt);
  }
  return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null;
}

const HISTORY_ROLE_ORDER: Readonly<Record<string, number>> = {
  assistant: 2,
  system: 0,
  tool: 3,
  user: 1,
};

function compareHistoryMessages(left: AssistantHistoryMessage, right: AssistantHistoryMessage) {
  const rowTimeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (rowTimeDifference !== 0) {
    return rowTimeDifference;
  }
  const leftRange = historyMessagePartTimeRange(left.content);
  const rightRange = historyMessagePartTimeRange(right.content);
  const firstPartDifference = (leftRange?.first ?? 0) - (rightRange?.first ?? 0);
  if (firstPartDifference !== 0) {
    return firstPartDifference;
  }
  const lastPartDifference = (leftRange?.last ?? 0) - (rightRange?.last ?? 0);
  if (lastPartDifference !== 0) {
    return lastPartDifference;
  }
  const roleDifference =
    (HISTORY_ROLE_ORDER[left.role] ?? Number.MAX_SAFE_INTEGER) -
    (HISTORY_ROLE_ORDER[right.role] ?? Number.MAX_SAFE_INTEGER);
  return roleDifference === 0 ? left.id.localeCompare(right.id) : roleDifference;
}

/**
 * assistant-ui imports parents before children. Mastra updates `createdAt` when
 * a regeneration reuses its user message ID, so persisted chronological order
 * is not necessarily topological. Close the bounded graph, then perform a
 * stable parent-first traversal without adding a database round trip.
 */
function orderHistoryGraphForImport(
  repositoryMessages: AssistantHistoryRepositoryMessages
): AssistantHistoryRepositoryMessages {
  const messageById = new Map<string, AssistantHistoryRepositoryMessages[number]>();
  for (const item of repositoryMessages) {
    if (messageById.has(item.message.id)) {
      throw new Error(`Assistant history contains duplicate message ID ${item.message.id}.`);
    }
    messageById.set(item.message.id, item);
  }

  const closedMessages = repositoryMessages.map((item) =>
    item.parentId !== null && !messageById.has(item.parentId) ? { ...item, parentId: null } : item
  );
  const closedMessageById = new Map(closedMessages.map((item) => [item.message.id, item]));
  const visitState = new Map<string, 'visited' | 'visiting'>();
  const orderedMessages: AssistantHistoryRepositoryMessages = [];

  const visit = (item: AssistantHistoryRepositoryMessages[number]): void => {
    const messageId = item.message.id;
    const state = visitState.get(messageId);
    if (state === 'visited') {
      return;
    }
    if (state === 'visiting') {
      throw new Error(`Assistant history contains a parent cycle at message ${messageId}.`);
    }
    visitState.set(messageId, 'visiting');
    if (item.parentId !== null) {
      const parent = closedMessageById.get(item.parentId);
      if (!parent) {
        throw new Error(`Assistant history parent ${item.parentId} disappeared while ordering.`);
      }
      visit(parent);
    }
    visitState.set(messageId, 'visited');
    orderedMessages.push(item);
  };

  for (const item of closedMessages) {
    visit(item);
  }
  return orderedMessages;
}

export function toHistoryRepository(
  messages: readonly AssistantHistoryMessage[],
  runEvents: readonly AssistantRunEvent[] = []
): Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>> {
  const repositoryMessages: Awaited<
    ReturnType<AssistantUiThreadHistoryAdapter['load']>
  >['messages'] = [];
  let parentId: string | null = null;
  const toolResultsByCallId = collectToolResults(messages);
  const orderedMessages = [...messages].sort(compareHistoryMessages);
  const units = buildHistoryUnits(orderedMessages, toolResultsByCallId);
  const runEventAssignments = assignRunEventsToGroups(units, runEvents);

  for (const unit of units) {
    if (unit.kind === 'assistant-group') {
      const appendedId = appendAssistantGroupMessage({
        group: unit,
        groupEventParts: runEventAssignments.get(unit) ?? [],
        parentId: resolveAssistantGroupParentId(unit, parentId),
        repositoryMessages,
      });
      if (appendedId !== null) {
        parentId = appendedId;
      }
      continue;
    }
    const appended =
      unit.kind === 'user'
        ? appendUserHistoryMessage({
            message: unit.message,
            parentId: unit.message.parentId === undefined ? parentId : unit.message.parentId,
            repositoryMessages,
          })
        : appendSystemHistoryMessage({
            message: unit.message,
            parentId: unit.message.parentId === undefined ? parentId : unit.message.parentId,
            repositoryMessages,
          });
    if (appended) {
      parentId = unit.message.id;
    }
  }

  const headId = repositoryMessages.at(-1)?.message.id ?? null;

  return {
    headId,
    messages: orderHistoryGraphForImport(repositoryMessages),
  };
}

/**
 * Synthetic rediscovered-pause message id prefixes. These ids exist only in
 * the hydrated UI thread (never as Mastra rows), so the topology adapter must
 * treat them as transient parents (BST-1243) — keep the prefix list and the
 * id construction in `appendSuspendedPauseMessages` in lockstep.
 */
const SUSPENDED_PAUSE_MESSAGE_ID_PREFIXES = ['suspended-approval', 'suspended-pause'] as const;

type SuspendedPauseMessageIdPrefix = (typeof SUSPENDED_PAUSE_MESSAGE_ID_PREFIXES)[number];

export function isSuspendedPauseMessageId(messageId: string): boolean {
  return SUSPENDED_PAUSE_MESSAGE_ID_PREFIXES.some((prefix) => messageId.startsWith(`${prefix}:`));
}

interface RediscoveredPauseMessageSource {
  readonly data: RediscoveredToolApproval | RediscoveredToolSuspend;
  readonly dataName: typeof TOOL_APPROVAL_DATA_NAME | typeof TOOL_SUSPEND_DATA_NAME;
  readonly idPrefix: SuspendedPauseMessageIdPrefix;
  readonly runId: string;
  readonly suspendedAt: string;
  readonly toolCallId: string;
}

/**
 * Append one synthetic trailing assistant message per rediscovered pause —
 * suspended APPROVALS (`TOOL_APPROVAL_DATA_NAME`) and, since BST-1084,
 * suspend() PAUSES (`TOOL_SUSPEND_DATA_NAME`) — each carrying a single data
 * part identical to the live-stream mapper's output, so the existing notices
 * render and their Approve/Decline / typed-resume actions reuse the
 * (restart-safe, stateless) resume seams unchanged. Ordered oldest-first (by
 * `suspendedAt`, both kinds interleaved) and chained onto the current head so
 * the notices sit at the bottom of the thread. `toHistoryRepository` stays
 * untouched (its many existing tests keep passing).
 */
export function appendSuspendedPauseMessages(
  result: AssistantHistoryLoadResult,
  approvals: readonly RediscoveredToolApproval[],
  suspends: readonly RediscoveredToolSuspend[]
): AssistantHistoryLoadResult {
  if (approvals.length === 0 && suspends.length === 0) {
    return result;
  }
  const sources: RediscoveredPauseMessageSource[] = [
    ...approvals.map(
      (approval): RediscoveredPauseMessageSource => ({
        data: approval,
        dataName: TOOL_APPROVAL_DATA_NAME,
        idPrefix: 'suspended-approval',
        runId: approval.runId,
        suspendedAt: approval.suspendedAt,
        toolCallId: approval.toolCallId,
      })
    ),
    ...suspends.map(
      (pause): RediscoveredPauseMessageSource => ({
        data: pause,
        dataName: TOOL_SUSPEND_DATA_NAME,
        idPrefix: 'suspended-pause',
        runId: pause.runId,
        suspendedAt: pause.suspendedAt,
        toolCallId: pause.toolCallId,
      })
    ),
  ].sort((a, b) => Date.parse(a.suspendedAt) - Date.parse(b.suspendedAt));

  const messages: AssistantHistoryRepositoryMessages = [...result.messages];
  let parentId: string | null = result.headId ?? null;
  let headId: string | null = result.headId ?? null;
  for (const source of sources) {
    const id = `${source.idPrefix}:${source.runId}:${source.toolCallId}`;
    messages.push({
      message: {
        content: [{ data: source.data, name: source.dataName, type: 'data' }],
        createdAt: new Date(source.suspendedAt),
        id,
        metadata: {
          custom: {},
          steps: [],
          // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
          unstable_annotations: [],
          // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
          unstable_data: [],
          // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
          unstable_state: null,
        },
        role: 'assistant',
        status: { reason: 'stop', type: 'complete' },
      },
      parentId,
    });
    parentId = id;
    headId = id;
  }
  return { headId, messages };
}
