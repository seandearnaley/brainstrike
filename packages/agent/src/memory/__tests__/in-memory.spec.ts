import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../..';
import { InMemoryMemoryStore } from '../in-memory';

const createMessage = (id: string, text: string): AgentMessage => ({
  id,
  parts: [{ text, type: 'text' }],
  role: 'user',
});

describe('InMemoryMemoryStore', () => {
  it('creates and appends messages to a conversation', () => {
    const store = new InMemoryMemoryStore();
    const first = createMessage('m-1', 'hello');
    const second = createMessage('m-2', 'world');

    store.append('c-1', first);
    store.append('c-1', second);

    expect(store.get('c-1')).toEqual({
      id: 'c-1',
      messages: [first, second],
    });
  });

  it('lists conversations and resets all data', () => {
    const store = new InMemoryMemoryStore();

    store.append('c-1', createMessage('m-1', 'one'));
    store.append('c-2', createMessage('m-2', 'two'));

    expect(store.list()).toHaveLength(2);
    expect(store.get('missing')).toBeUndefined();

    store.reset();

    expect(store.list()).toEqual([]);
    expect(store.get('c-1')).toBeUndefined();
    expect(store.get('c-2')).toBeUndefined();
  });
});
