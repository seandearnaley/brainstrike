import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { createSubagentInvocationIndex } from '../subagent-invocation-index-model';

function event(parent: string, child: string, kind = 'subagent.tool.started') {
  return {
    data: {
      id: `${kind}-${child}`,
      kind,
      label: kind,
      metadata: { childToolName: 'read', parentToolCallId: parent, toolCallId: child },
      status: 'running',
      timestamp: '2026-09-15T00:00:00.000Z',
    },
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data',
  };
}

function outcome(parent: string, value: 'no-answer' | 'rejected' | 'truncated') {
  const part = event(parent, 'terminal', 'subagent.failed');
  return {
    ...part,
    data: { ...part.data, metadata: { ...part.data.metadata, outcome: value } },
  };
}

function message(id: string, parts: readonly unknown[], status = 'running') {
  return { id, parts, status: { type: status } };
}

describe('subagent invocation index', () => {
  it.each([1000, 5000, 10_000])(
    'reads %i retained parts once, then only an appended tail',
    (count) => {
      const inspect = vi.fn();
      const index = createSubagentInvocationIndex({ inspect });
      const parts = Array.from({ length: count }, (_, partIndex) =>
        event(`delegation-${partIndex % 4}`, `child-${partIndex}`)
      );
      const messages = [message('assistant-1', parts)];

      index.advance(messages);
      expect(inspect).toHaveBeenCalledTimes(count);
      const snapshots = Array.from({ length: 4 }, (_, i) => index.getSnapshot(`delegation-${i}`));

      index.advance(messages);
      expect(inspect).toHaveBeenCalledTimes(count);
      snapshots.forEach((snapshot, i) => {
        expect(index.getSnapshot(`delegation-${i}`)).toBe(snapshot);
      });

      const appended = event('delegation-2', `child-${count}`);
      parts.push(appended);
      index.advance(messages);
      expect(inspect).toHaveBeenCalledTimes(count + 1);
      expect(index.getSnapshot('delegation-0')).toBe(snapshots[0]);
      expect(index.getSnapshot('delegation-2')).not.toBe(snapshots[2]);

      const immutableAppend = [...parts, event('delegation-3', `child-${count + 1}`)];
      index.advance([message('assistant-1', immutableAppend)]);
      expect(inspect).toHaveBeenCalledTimes(count + 2);
      expect(index.getSnapshot('delegation-0')).toBe(snapshots[0]);
      expect(index.getSnapshot('delegation-3')).not.toBe(snapshots[3]);
    }
  );

  it('combines sibling messages, applies later events, and settles running rows without rescanning', () => {
    const inspect = vi.fn();
    const index = createSubagentInvocationIndex({ inspect });
    const first = message('assistant-1', [event('delegation-1', 'child-1')]);
    const resumed = message('assistant-2', [
      event('delegation-1', 'child-1', 'subagent.tool.completed'),
    ]);

    index.advance([first, resumed]);
    expect(index.getSnapshot('delegation-1').rows[0]?.status).toBe('success');
    expect(inspect).toHaveBeenCalledTimes(2);

    const interrupted = message('assistant-3', [event('delegation-2', 'child-2')]);
    index.advance([first, resumed, interrupted]);
    index.advance([first, resumed, { ...interrupted, status: { type: 'incomplete' } }]);
    expect(index.getSnapshot('delegation-2').rows[0]?.status).toBe('interrupted');
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it('does not revisit immutable data parts when another same-length part is replaced', () => {
    const inspect = vi.fn();
    const index = createSubagentInvocationIndex({ inspect });
    const retainedEvent = event('delegation-1', 'child-1');
    index.advance([message('assistant-1', [retainedEvent, { text: 'first', type: 'text' }])]);
    const snapshot = index.getSnapshot('delegation-1');

    index.advance([message('assistant-1', [retainedEvent, { text: 'second', type: 'text' }])]);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(index.getSnapshot('delegation-1')).toBe(snapshot);
  });

  it('rebuilds on message topology changes and requires stable message ids', () => {
    const index = createSubagentInvocationIndex();
    const first = message('assistant-1', [event('delegation-1', 'child-1')]);
    const second = message('assistant-2', [event('delegation-2', 'child-2')]);
    index.advance([first, second]);
    index.advance([second]);
    expect(index.getSnapshot('delegation-1').rows).toEqual([]);
    expect(index.getSnapshot('delegation-2').rows).toHaveLength(1);
    expect(() => index.advance([{ parts: [] }])).toThrow('stable string id');
  });

  it('rebuilds same-id authoritative replacements, shrink, reorder, rows, and outcomes', () => {
    const index = createSubagentInvocationIndex();
    const first = message(
      'assistant-1',
      [event('delegation-1', 'child-1'), outcome('delegation-1', 'no-answer')],
      'complete'
    );
    index.advance([first]);
    expect(index.getSnapshot('delegation-1')).toMatchObject({ outcome: 'no-answer' });

    const replacement = message(
      'assistant-1',
      [event('delegation-1', 'child-2'), outcome('delegation-1', 'rejected')],
      'complete'
    );
    index.advance([replacement]);
    expect(index.getSnapshot('delegation-1')).toMatchObject({
      outcome: 'rejected',
      rows: [{ key: 'child-2' }],
    });

    index.advance([message('assistant-1', [outcome('delegation-1', 'truncated')], 'complete')]);
    expect(index.getSnapshot('delegation-1')).toMatchObject({ outcome: 'truncated', rows: [] });

    const sibling = message('assistant-2', [event('delegation-2', 'child-3')]);
    index.advance([replacement, sibling]);
    index.advance([sibling, replacement]);
    expect(index.getSnapshot('delegation-2').rows).toHaveLength(1);
  });

  it('rebuilds when an authoritative replacement changes retained data before an append or text tail', () => {
    const inspect = vi.fn();
    const index = createSubagentInvocationIndex({ inspect });
    const originalEvent = event('delegation-1', 'child-1');
    const originalTail = { text: 'streaming', type: 'text' };
    index.advance([message('assistant-1', [originalEvent, originalTail], 'complete')]);

    const appendedReplacement = [
      event('delegation-1', 'child-2'),
      originalTail,
      { text: 'appended', type: 'text' },
    ];
    index.advance([message('assistant-1', appendedReplacement, 'complete')]);
    expect(index.getSnapshot('delegation-1').rows).toMatchObject([{ key: 'child-2' }]);

    index.advance([
      message(
        'assistant-1',
        [
          event('delegation-1', 'child-3'),
          appendedReplacement[1],
          { text: 'new tail', type: 'text' },
        ],
        'complete'
      ),
    ]);
    expect(index.getSnapshot('delegation-1').rows).toMatchObject([{ key: 'child-3' }]);
    expect(inspect).toHaveBeenCalledTimes(8);
  });

  it('does not rescan when only message metadata can have changed', () => {
    const inspect = vi.fn();
    const index = createSubagentInvocationIndex({ inspect });
    const parts = [event('delegation-1', 'child-1'), { text: 'stable', type: 'text' }];
    index.advance([message('assistant-1', parts)]);
    index.advance([message('assistant-1', [...parts])]);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a running same-id replacement that retains its final two parts', () => {
    const index = createSubagentInvocationIndex();
    const retainedText = { text: 'retained', type: 'text' };
    const retainedTail = { text: 'tail', type: 'text' };
    index.advance([
      message('assistant-1', [event('delegation-1', 'child-1'), retainedText, retainedTail]),
    ]);
    index.advance([
      message('assistant-1', [event('delegation-1', 'child-2'), retainedText, retainedTail]),
    ]);
    expect(index.getSnapshot('delegation-1').rows).toMatchObject([{ key: 'child-2' }]);
  });

  it('notifies only the changed invocation and removes listeners cleanly', () => {
    const index = createSubagentInvocationIndex();
    const one = vi.fn();
    const two = vi.fn();
    const unsubscribeOne = index.subscribe('delegation-1', one);
    index.subscribe('delegation-2', two);
    const parts: unknown[] = [event('delegation-1', 'child-1')];
    const messages = [message('assistant-1', parts)];
    index.advance(messages);
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
    unsubscribeOne();
    parts.push(event('delegation-1', 'child-2'));
    index.advance(messages);
    expect(one).toHaveBeenCalledTimes(1);
  });
});
