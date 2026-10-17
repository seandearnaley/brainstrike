import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import {
  type ModelMessage,
  modelMessageSchema,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
} from 'ai';
import { committedRowAddress, committedRunIdentity } from '../committed-identities.js';
import type { HostLogRow } from '../protocol.js';

type CommittedModelRow = HostLogRow & {
  readonly event: Extract<HostLogRow['event'], { type: 'model.step' | 'model.messages' }>;
};

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

/** Immutable native segments address existing rows; there is no message-ID writer. */
export function committedMemoryTranscript(
  rows: readonly HostLogRow[],
  resourceId: string
): MastraDBMessage[] {
  const committed = new Map(
    rows.flatMap((row): [HostLogRow, ModelMessage[]][] =>
      row.event.type === 'model.step' || row.event.type === 'model.messages'
        ? [[row, row.event.messages.map((message) => modelMessageSchema.parse(message))]]
        : []
    )
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
    const previous: MastraDBMessage[] = [];
    let modelMetadata: ReturnType<typeof committedModelMetadata>;
    const segments = rows.filter(
      (row): row is CommittedModelRow =>
        row.threadId === started.threadId &&
        (row.event.type === 'model.step' || row.event.type === 'model.messages') &&
        row.event.runId === runId
    );
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
      if (row.ts === undefined) {
        throw new Error('Native segment requires its committed SQLite timestamp');
      }
      const id = committedRowAddress(row);
      const native = new MessageList({
        generateMessageId: () => id,
        resourceId,
        threadId: row.threadId,
      });
      // Conversion borrows preceding calls to recover result arguments. A
      // later approval/result row never updates the earlier call segment.
      native.add(structuredClone(previous), 'memory');
      const converted = (committed.get(row) ?? [])
        .map((message) => withoutApprovals(message, automaticAllows))
        // A message that held only an automatic approval has nothing left to convert.
        .filter((message) => typeof message.content === 'string' || message.content.length > 0);
      converted.forEach((message, index) => {
        native.add(
          [
            {
              ...message,
              id,
              metadata: { createdAt: new Date(row.ts as number), ...modelMetadata },
            },
          ],
          'response',
          { merge: index > 0 }
        );
      });
      const segment = native.get.all.db().find((message) => message.id === id);
      if (segment?.role !== 'assistant') {
        throw new Error('Public converter cannot represent the committed SDK segment');
      }
      segment.createdAt = new Date(row.ts);
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
      previous.push(segment);
      append(segment);
    }
  }
  return messages;
}
