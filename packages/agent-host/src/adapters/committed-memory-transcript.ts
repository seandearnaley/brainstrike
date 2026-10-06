import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { modelMessageSchema } from 'ai';
import { committedRowAddress, committedRunIdentity } from '../committed-identities.js';
import type { HostLogRow } from '../protocol.js';

/** Immutable native segments address existing rows; there is no message-ID writer. */
export function committedMemoryTranscript(
  rows: readonly HostLogRow[],
  resourceId: string
): MastraDBMessage[] {
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
    append({
      content: { format: 2, parts: [{ text: started.event.prompt, type: 'text' }] },
      createdAt: identity.createdAt,
      id: identity.userMessageId,
      resourceId,
      role: 'user',
      threadId: started.threadId,
    });
    const previous: MastraDBMessage[] = [];
    for (const row of rows) {
      const event = row.event;
      if (
        row.threadId !== started.threadId ||
        !(event.type === 'model.step' || event.type === 'model.messages') ||
        event.runId !== runId ||
        event.messages.length === 0
      ) {
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
      event.messages.forEach((message, index) => {
        native.add(
          [
            {
              ...modelMessageSchema.parse(message),
              id,
              metadata: { createdAt: new Date(row.ts as number) },
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
      // Optional part stamps produced by conversion are not committed facts.
      segment.content.parts = segment.content.parts.map(
        ({ createdAt: _ephemeral, ...part }) => part
      );
      previous.push(segment);
      append(segment);
    }
  }
  return messages;
}
