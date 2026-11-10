import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import {
  type ModelMessage,
  modelMessageSchema,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
} from 'ai';
import { committedRowAddress, committedRunIdentity } from '../committed-identities.ts';
import type { HostLogRow } from '../protocol.ts';

type CommittedModelRow = HostLogRow & {
  readonly event: Extract<HostLogRow['event'], { type: 'model.step' | 'model.messages' }>;
};

function isCommittedModelRow(row: HostLogRow): row is CommittedModelRow {
  return row.event.type === 'model.step' || row.event.type === 'model.messages';
}

function committedModelMetadata(
  model: unknown
): { readonly modelId: string; readonly provider: string } | undefined {
  if (
    model === null ||
    typeof model !== 'object' ||
    Array.isArray(model) ||
    !('modelId' in model) ||
    !('provider' in model) ||
    typeof model.modelId !== 'string' ||
    model.modelId.length === 0 ||
    typeof model.provider !== 'string' ||
    model.provider.length === 0
  ) {
    return;
  }
  return { modelId: model.modelId, provider: model.provider };
}

/**
 * Workaround for @mastra/core 1.71.0 MessageList: converting a tool message
 * that carries an approval response before its tool result appends the
 * `approval-responded` part after the result's part
 * (dist/message-list-DxPv9dgd.js 9506–9522), and merging then overwrites the call's
 * `result` state with `approval-responded` (10768–10775), although its own
 * ranking puts `result` above it (11725). Every host call the policy allows
 * carries the SDK's automatic approval pair, so each would read as unanswered,
 * and Mastra's tool search, which counts only `result`, would load nothing.
 * Only those automatic `allow` pairs are left out of the conversion; the log
 * keeps them, and a user-answered approval converts as committed.
 * Remove when Mastra keeps `result` over `approval-responded` in this merge.
 */
function automaticAllowApprovals(segments: readonly (readonly ModelMessage[])[]): Set<string> {
  const parts = segments.flat().flatMap(approvalParts);
  const allowed = new Set(
    parts.flatMap((part) =>
      part.type === 'tool-approval-response' && part.approved ? [part.approvalId] : []
    )
  );
  return new Set(
    parts.flatMap((part) =>
      part.type === 'tool-approval-request' &&
      part.isAutomatic === true &&
      allowed.has(part.approvalId)
        ? [part.approvalId]
        : []
    )
  );
}

function approvalParts(message: ModelMessage): (ToolApprovalRequest | ToolApprovalResponse)[] {
  if (message.role === 'assistant' && typeof message.content !== 'string') {
    return message.content.filter(
      (part): part is ToolApprovalRequest => part.type === 'tool-approval-request'
    );
  }
  if (message.role === 'tool') {
    return message.content.filter(
      (part): part is ToolApprovalResponse => part.type === 'tool-approval-response'
    );
  }
  return [];
}

function withoutApprovals(message: ModelMessage, approvals: ReadonlySet<string>): ModelMessage {
  if (message.role === 'assistant' && typeof message.content !== 'string') {
    return {
      ...message,
      content: message.content.filter(
        (part) => !(part.type === 'tool-approval-request' && approvals.has(part.approvalId))
      ),
    };
  }
  if (message.role === 'tool') {
    return {
      ...message,
      content: message.content.filter(
        (part) => !(part.type === 'tool-approval-response' && approvals.has(part.approvalId))
      ),
    };
  }
  return message;
}

/**
 * The earlier segments a row's conversion borrows from: those holding a call
 * that this row answers without carrying the call itself (a result committed
 * after an approval pause, a continuation). A step commits its calls with
 * their results, so most rows borrow none. An approval names its call by
 * approval ID, not by call, so a row with one borrows every earlier segment.
 */
function borrowedSegments(
  previous: readonly MastraDBMessage[],
  messages: readonly ModelMessage[]
): readonly MastraDBMessage[] {
  if (messages.some((message) => approvalParts(message).length > 0)) {
    return previous;
  }
  const own = toolCallIds(messages, 'tool-call');
  const borrowed = new Set(
    [...toolCallIds(messages, 'tool-result')].filter((toolCallId) => !own.has(toolCallId))
  );
  if (borrowed.size === 0) {
    return [];
  }
  return previous.filter((segment) =>
    segment.content.parts.some(
      (part) => part.type === 'tool-invocation' && borrowed.has(part.toolInvocation.toolCallId)
    )
  );
}

/** The calls a row's messages make (`tool-call`) or answer (`tool-result`). */
function toolCallIds(
  messages: readonly ModelMessage[],
  type: 'tool-call' | 'tool-result'
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (
      (message.role !== 'assistant' && message.role !== 'tool') ||
      typeof message.content === 'string'
    ) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === type) {
        ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}

/** One committed model segment, as Memory stores it: one assistant message. */
function assistantSegment(
  row: CommittedModelRow,
  id: string,
  resourceId: string,
  previous: readonly MastraDBMessage[],
  messages: readonly ModelMessage[],
  modelMetadata: ReturnType<typeof committedModelMetadata>
): MastraDBMessage {
  const ts = row.ts;
  if (ts === undefined) {
    throw new Error('Native segment requires its committed SQLite timestamp');
  }
  const native = new MessageList({
    generateMessageId: () => id,
    resourceId,
    threadId: row.threadId,
  });
  // Conversion borrows preceding calls to recover result arguments. A
  // later approval/result row never updates the earlier call segment, so the
  // converter gets its own copy: of the segments this row borrows from only,
  // since copying every earlier segment for every row made a run's transcript
  // cost the square of its steps, on each of the reads a step makes.
  const borrowed = borrowedSegments(previous, messages);
  if (borrowed.length > 0) {
    native.add(structuredClone([...borrowed]), 'memory');
  }
  messages
    // A message that held only an automatic approval has nothing left to convert.
    .filter((message) => typeof message.content === 'string' || message.content.length > 0)
    .forEach((message, index) => {
      native.add(
        [{ ...message, id, metadata: { createdAt: new Date(ts), ...modelMetadata } }],
        'response',
        { merge: index > 0 }
      );
    });
  const segment = native.get.all.db().find((message) => message.id === id);
  if (segment?.role !== 'assistant') {
    throw new Error('Public converter cannot represent the committed SDK segment');
  }
  segment.createdAt = new Date(ts);
  // Optional part stamps produced by conversion are not committed facts:
  // `createdAt`, and since @mastra/core 1.78 a tool part's merge-time
  // `updatedAt` (message-list/utils/stamp-part.ts).
  segment.content.parts = segment.content.parts.map(({ createdAt: _ephemeral, ...part }) => {
    if (part.type !== 'tool-invocation') {
      return part;
    }
    const { updatedAt: _merged, ...invocation } = part;
    return invocation;
  });
  return segment;
}

/** The user message a step's notices commit, as Memory stores it. */
function intakeSegment(
  row: CommittedModelRow,
  id: string,
  resourceId: string,
  messages: readonly ModelMessage[]
): MastraDBMessage {
  const native = new MessageList({
    generateMessageId: () => id,
    resourceId,
    threadId: row.threadId,
  });
  native.add(
    messages.map((message) => ({ ...message, id })),
    'input'
  );
  const segment = native.get.all.db().find((message) => message.id === id);
  if (segment?.role !== 'user' || row.ts === undefined) {
    throw new Error('Public converter cannot represent the committed notice');
  }
  segment.createdAt = new Date(row.ts);
  segment.content.parts = segment.content.parts.map(({ createdAt: _ephemeral, ...part }) => part);
  return segment;
}

/** One run's committed model segments, as Memory stores them, in commit order. */
function runSegments(
  segments: readonly CommittedModelRow[],
  committed: ReadonlyMap<HostLogRow, ModelMessage[]>,
  automaticAllows: ReadonlySet<string>,
  resourceId: string
): MastraDBMessage[] {
  const converted: MastraDBMessage[] = [];
  const previous: MastraDBMessage[] = [];
  let modelMetadata: ReturnType<typeof committedModelMetadata>;
  for (const row of segments) {
    const event = row.event;
    // Signed reasoning uses the exact SDK identity, not the request's provider
    // family. Continuation results borrow only this run's preceding step.
    if (event.type === 'model.step') {
      modelMetadata = committedModelMetadata(event.model);
    }
    if (event.messages.length === 0) {
      continue;
    }
    const id = committedRowAddress(row);
    const messages = committed.get(row) ?? [];
    // ADR-0028 step 3b: the notices a running run took at a step reach its
    // model as one user message of their own, inside the run's turn.
    const segment =
      event.type === 'model.messages' && event.delivery
        ? intakeSegment(row, id, resourceId, messages)
        : assistantSegment(
            row,
            id,
            resourceId,
            previous,
            messages.map((message) => withoutApprovals(message, automaticAllows)),
            modelMetadata
          );
    if (segment.role === 'assistant') {
      previous.push(segment);
    }
    converted.push(segment);
  }
  return converted;
}

/**
 * Each committed row's messages, validated once. A row never changes and Core
 * hands every read the same row objects (`HostCommittedRows`), where
 * validating every row again on each of a step's reads cost a run the square
 * of its steps. A reader gets its own copy, as it did from a fresh parse.
 */
const validatedMessages = new WeakMap<HostLogRow, readonly ModelMessage[]>();

function committedModelMessages(row: CommittedModelRow): ModelMessage[] {
  let messages = validatedMessages.get(row);
  if (!messages) {
    messages = row.event.messages.map((message) => modelMessageSchema.parse(message));
    validatedMessages.set(row, messages);
  }
  return structuredClone([...messages]);
}

/** Immutable native segments address existing rows; there is no message-ID writer. */
export function committedMemoryTranscript(
  rows: readonly HostLogRow[],
  resourceId: string
): MastraDBMessage[] {
  const committed = new Map(
    rows
      .filter(isCommittedModelRow)
      .map((row): [HostLogRow, ModelMessage[]] => [row, committedModelMessages(row)])
  );
  const automaticAllows = automaticAllowApprovals([...committed.values()]);
  const messages: MastraDBMessage[] = [];
  const ids = new Set<string>();
  const append = (message: MastraDBMessage): void => {
    if (ids.has(message.id)) {
      throw new Error('Committed conversation identities collide across threads');
    }
    ids.add(message.id);
    messages.push(message);
  };
  for (const started of rows) {
    if (started.event.type !== 'run.started') {
      continue;
    }
    const runId = started.event.runId;
    const identity = committedRunIdentity(rows, runId);
    // A regeneration answers its committed user message again; only the
    // run/start that committed it contributes the message.
    if (started.event.userMessageId === undefined) {
      append({
        content: { format: 2, parts: [{ text: started.event.prompt, type: 'text' }] },
        createdAt: identity.createdAt,
        id: identity.userMessageId,
        resourceId,
        role: 'user',
        threadId: started.threadId,
      });
    }
    const segments = rows.filter(
      (row): row is CommittedModelRow =>
        isCommittedModelRow(row) && row.threadId === started.threadId && row.event.runId === runId
    );
    for (const segment of runSegments(segments, committed, automaticAllows, resourceId)) {
      append(segment);
    }
  }
  return messages;
}
