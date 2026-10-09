import { describe, expect, test } from 'vitest';
import { createHostRunState, HostRunMap } from '../src/core-state.js';

const run = (threadId: string, runId: string) =>
  createHostRunState(
    threadId,
    runId,
    'openai::gpt-6-sol',
    { parentMessageId: null, prompt: runId, userMessageId: `user-${runId}` },
    { categories: new Set(), tools: new Set() }
  );

describe("Core's runs, by id and by thread", () => {
  test('each thread lists its runs in the order they were folded', () => {
    const runs = new HostRunMap();
    for (const [threadId, runId] of [
      ['a', 'a1'],
      ['b', 'b1'],
      ['a', 'a2'],
      ['b', 'b2'],
      ['a', 'a3'],
    ] as const) {
      runs.set(runId, run(threadId, runId));
    }
    expect(runs.ofThread('a').map(({ id }) => id)).toEqual(['a1', 'a2', 'a3']);
    expect(runs.ofThread('b').map(({ id }) => id)).toEqual(['b1', 'b2']);
    expect(runs.ofThread('c')).toEqual([]);
  });

  test('replacing a run keeps its place; deleting one closes the gap', () => {
    const runs = new HostRunMap();
    runs.set('a1', run('a', 'a1')).set('a2', run('a', 'a2')).set('a3', run('a', 'a3'));
    const replacement = run('a', 'a2');
    runs.set('a2', replacement);
    expect(runs.ofThread('a')[1]).toBe(replacement);
    runs.delete('a2');
    expect(runs.ofThread('a').map(({ id }) => id)).toEqual(['a1', 'a3']);
    expect(runs.has('a2')).toBe(false);
    runs.delete('a1');
    runs.delete('a3');
    expect(runs.ofThread('a')).toEqual([]);
    expect(runs.size).toBe(0);
  });
});
