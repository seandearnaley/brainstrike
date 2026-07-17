import { describe, expect, it } from 'vitest';
import { resolveAssistantThreadTabDrop } from '../assistant-thread-tabs-dnd';

const ORDER = ['thread-a', 'thread-b', 'thread-c', 'thread-d'] as const;

describe('resolveAssistantThreadTabDrop', () => {
  it('places a dragged tab before the target left edge', () => {
    expect(
      resolveAssistantThreadTabDrop({
        openThreadIds: ORDER,
        source: { threadId: 'thread-d', type: 'assistant-thread-tab' },
        target: { edge: 'left', threadId: 'thread-b', type: 'assistant-thread-tab' },
      })
    ).toEqual({
      kind: 'reorder',
      orderedThreadIds: ['thread-a', 'thread-d', 'thread-b', 'thread-c'],
    });
  });

  it('places a dragged tab after the target right edge', () => {
    expect(
      resolveAssistantThreadTabDrop({
        openThreadIds: ORDER,
        source: { threadId: 'thread-a', type: 'assistant-thread-tab' },
        target: { edge: 'right', threadId: 'thread-c', type: 'assistant-thread-tab' },
      })
    ).toEqual({
      kind: 'reorder',
      orderedThreadIds: ['thread-b', 'thread-c', 'thread-a', 'thread-d'],
    });
  });

  it('returns none for a self-drop or an order-preserving adjacent drop', () => {
    expect(
      resolveAssistantThreadTabDrop({
        openThreadIds: ORDER,
        source: { threadId: 'thread-b', type: 'assistant-thread-tab' },
        target: { edge: 'left', threadId: 'thread-b', type: 'assistant-thread-tab' },
      })
    ).toEqual({ kind: 'none' });
    expect(
      resolveAssistantThreadTabDrop({
        openThreadIds: ORDER,
        source: { threadId: 'thread-b', type: 'assistant-thread-tab' },
        target: { edge: 'right', threadId: 'thread-a', type: 'assistant-thread-tab' },
      })
    ).toEqual({ kind: 'none' });
  });

  it('fails loudly when drag data names a tab outside the current open order', () => {
    expect(() =>
      resolveAssistantThreadTabDrop({
        openThreadIds: ORDER,
        source: { threadId: 'missing', type: 'assistant-thread-tab' },
        target: { edge: 'left', threadId: 'thread-b', type: 'assistant-thread-tab' },
      })
    ).toThrow('Dragged assistant thread tab is not open.');
    expect(() =>
      resolveAssistantThreadTabDrop({
        openThreadIds: ORDER,
        source: { threadId: 'thread-a', type: 'assistant-thread-tab' },
        target: { edge: 'left', threadId: 'missing', type: 'assistant-thread-tab' },
      })
    ).toThrow('Assistant thread tab drop target is not open.');
  });
});
