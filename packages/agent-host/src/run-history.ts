/**
 * A run's earlier turns as its request sends them, from the thread's committed
 * log: the selected branch only, without the turns a committed compaction
 * replaced, and an interrupted or stopped turn healed.
 */
import { healInterruptedModelMessages } from '@brainstrike/agent/provider-request';
import type { MastraDBMessage } from '@mastra/core/agent';
import { type ModelMessage, modelMessageSchema } from 'ai';
import { withHostDeliveryLedger } from './child-delivery.ts';
import {
  committedRowAddress,
  committedRunAncestors,
  committedRunIdentity,
} from './committed-identities.ts';
import { committedTranscript } from './committed-transcript.ts';
import { compactedRunIds } from './context-compaction.ts';
import type { HostLogRow } from './protocol.ts';

export interface HostRunHistory {
  /** The committed transcript addresses (`committedTranscript`) the messages come from. */
  readonly ids: ReadonlySet<string>;
  readonly messages: ModelMessage[];
  /** The earlier runs whose turns the messages hold. */
  readonly runIds: ReadonlySet<string>;
}

/** A turn's committed messages, healed when it was interrupted or stopped. */
function committedTurnMessages(
  rows: readonly HostLogRow[],
  started: HostLogRow,
  runId: string,
  ids: Set<string>
): ModelMessage[] {
  const committed = rows.flatMap((row) => {
    const event = row.event;
    if (
      row.threadId === started.threadId &&
      (event.type === 'model.step' || event.type === 'model.messages') &&
      event.runId === runId
    ) {
      ids.add(committedRowAddress(row));
      return event.messages.map((message) => modelMessageSchema.parse(message));
    }
    return [];
  });
  const interrupted = rows.flatMap(({ event }) =>
    event.type === 'run.finished' &&
    event.runId === runId &&
    (event.outcome === 'interrupted' || event.outcome === 'stopped')
      ? [event.outcome]
      : []
  )[0];
  if (!interrupted) {
    return committed;
  }
  const calls = new Set(
    committed.flatMap((message) =>
      message.role === 'assistant' && typeof message.content !== 'string'
        ? message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : []))
        : []
    )
  );
  return healInterruptedModelMessages(committed, calls, interrupted);
}

/**
 * The earlier turns of `run`'s branch that `selected` (committed transcript
 * addresses) holds, oldest first.
 */
export function committedRunHistory(
  rows: readonly HostLogRow[],
  run: { readonly runId: string },
  selected: ReadonlySet<string>
): HostRunHistory {
  const messages: ModelMessage[] = [];
  const ids = new Set<string>();
  const runIds = new Set<string>();
  // In this thread only the selected branch is history: a sibling branch's
  // turns never enter the request, even when they are selected.
  const path = new Set(committedRunAncestors(rows, run.runId));
  // A committed compaction replaces whole earlier turns: no selection re-adds
  // one (Core adds the note).
  const compacted = compactedRunIds(rows);
  for (const started of rows) {
    if (
      started.event.type !== 'run.started' ||
      started.event.runId === run.runId ||
      compacted.has(started.event.runId) ||
      !path.has(started.event.runId)
    ) {
      continue;
    }
    const previousRunId = started.event.runId;
    const previous = committedRunIdentity(rows, previousRunId);
    // BST-1977's ordinary second turn failed when the bounded native history
    // window started inside an older turn. Its assistant tail cannot be a
    // standalone provider conversation, so only a selected question anchors
    // its committed turn.
    if (!selected.has(previous.userMessageId)) {
      continue;
    }
    messages.push(
      withHostDeliveryLedger(
        { content: started.event.prompt, role: 'user' },
        started.event.delivery
      )
    );
    ids.add(previous.userMessageId);
    runIds.add(previousRunId);
    if (
      rows.some(
        (row) =>
          'runId' in row.event &&
          row.event.runId === previousRunId &&
          selected.has(committedRowAddress(row))
      )
    ) {
      messages.push(...committedTurnMessages(rows, started, previousRunId, ids));
    }
  }
  return { ids, messages, runIds };
}

/**
 * The provenance of one request: the committed transcript of the earlier turns
 * it sends (`historicalIds`), what precedes the run's own turn, then the run's
 * own committed messages. It borrows the exact committed occurrences, so a
 * selected known call is never lost to an omitted turn that reuses its SDK ID.
 */
export function hostProviderHistory(
  rows: readonly HostLogRow[],
  run: { readonly resourceId: string; readonly runId: string; readonly threadId: string },
  historicalIds: ReadonlySet<string>,
  continuation: readonly MastraDBMessage[]
): MastraDBMessage[] {
  const currentIds = new Set<string>();
  currentIds.add(committedRunIdentity(rows, run.runId).userMessageId);
  for (const row of rows) {
    if (row.threadId === run.threadId && 'runId' in row.event && row.event.runId === run.runId) {
      currentIds.add(committedRowAddress(row));
    }
  }
  const transcript = committedTranscript(rows, run.resourceId);
  return [
    ...transcript.filter((message) => historicalIds.has(message.id)),
    ...continuation,
    ...transcript.filter((message) => currentIds.has(message.id)),
  ];
}
