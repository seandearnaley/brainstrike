/**
 * The history projection engine, tested as the pure function it is (BST-1651).
 *
 * `toHistoryRepository` takes durable message rows plus run events and returns
 * the assistant-ui thread repository the renderer hydrates from. It touches no
 * database — yet before the split it lived in the middle of a 4,180-line module
 * whose only public entry point was a PGlite-backed repository, so every one of
 * its behaviors was covered by booting a real Postgres. These cases construct
 * their inputs directly.
 */
import type { AssistantRunEvent } from '@brainstrike/assistant-contract/run-events';
import { describe, expect, it } from 'vitest';
import { toHistoryRepository } from '../assistant-history-projection';
import type { AssistantHistoryMessage } from '../assistant-thread-types';

function row(
  id: string,
  role: string,
  content: unknown,
  minute: number,
  parentId?: string | null
): AssistantHistoryMessage {
  return {
    content,
    createdAt: new Date(Date.UTC(2026, 8, 5, 12, minute)),
    id,
    ...(parentId === undefined ? {} : { parentId }),
    role,
  };
}

function textContent(text: string): unknown {
  return { content: [{ text, type: 'text' }] };
}

function runEvent(overrides: Partial<AssistantRunEvent> & { id: string }): AssistantRunEvent {
  return {
    kind: 'tool.completed',
    label: 'Tool completed',
    sequence: 1,
    status: 'completed',
    timestamp: new Date(Date.UTC(2026, 8, 5, 12, 1)).toISOString(),
    ...overrides,
  };
}

describe('toHistoryRepository (pure; no database)', () => {
  it('projects a user turn and an assistant reply as a parent-linked chain', () => {
    const repository = toHistoryRepository([
      row('user-1', 'user', textContent('Deploy it'), 0),
      row('assistant-1', 'assistant', textContent('Deployed'), 1),
    ]);

    expect(repository.messages.map((entry) => [entry.message.id, entry.parentId])).toEqual([
      ['user-1', null],
      ['assistant-1', 'user-1'],
    ]);
    expect(repository.messages[1]?.message.role).toBe('assistant');
  });

  it('collapses consecutive assistant rows for one turn into a single message', () => {
    // Observational-memory sealing and per-step saves split ONE live assistant
    // turn across several rows; hydration must show what streamed, not the
    // storage shape.
    const repository = toHistoryRepository([
      row('user-1', 'user', textContent('Two steps please'), 0),
      row('assistant-1', 'assistant', textContent('First'), 1),
      row('assistant-2', 'assistant', textContent('Second'), 2),
    ]);

    expect(repository.messages).toHaveLength(2);
    const assistant = repository.messages[1]?.message;
    // No row here carries branch topology (`parentId`), which is the legacy
    // shape: the group then takes the LAST row's id, so the next message
    // attaches to the newest snapshot rather than to a superseded one.
    expect(assistant?.id).toBe('assistant-2');
    expect(
      (assistant?.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
    ).toEqual(['First', 'Second']);
  });

  it('orders by timestamp, and puts the user turn first when timestamps tie', () => {
    // A same-millisecond tie is real: a turn's user row and its first assistant
    // row can be written in the same transaction. Ordering by timestamp alone
    // would let the reply hydrate above the question it answers.
    const repository = toHistoryRepository([
      row('assistant-1', 'assistant', textContent('Answer'), 0),
      row('user-1', 'user', textContent('Question'), 0),
    ]);

    expect(repository.messages.map((entry) => entry.message.id)).toEqual(['user-1', 'assistant-1']);
  });

  it('weaves run events into the assistant turn they belong to', () => {
    const repository = toHistoryRepository(
      [
        row('user-1', 'user', textContent('Run the tool'), 0),
        row('assistant-1', 'assistant', textContent('Done'), 1),
      ],
      // `runId` is what binds an event to a run, and a run to the assistant
      // group it streamed into; an event without one is deliberately dropped.
      [runEvent({ id: 'event-1', label: 'read_file', runId: 'run-1' })]
    );

    const assistant = repository.messages[1]?.message;
    const dataParts = (assistant?.content ?? []).filter((part) => part.type === 'data');
    expect(dataParts).toHaveLength(1);
    expect((dataParts[0] as { data: AssistantRunEvent }).data.id).toBe('event-1');
  });

  it('returns an empty repository for no rows rather than inventing a head', () => {
    expect(toHistoryRepository([])).toEqual({ headId: null, messages: [] });
  });
});
