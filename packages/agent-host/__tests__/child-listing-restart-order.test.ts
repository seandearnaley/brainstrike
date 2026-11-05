/**
 * A restart folds the threads in id order, so a nested subagent can come back
 * before the subagent that started it. Its parent's listing, and the colours of
 * the whole tree, must still answer.
 */
import { expect, test } from 'vitest';
import { HostChildRuns } from '../src/core-child-runs.ts';
import type { HostChildOrigin, HostLogRow } from '../src/protocol.ts';

function started(threadId: string, parentThreadId: string, depth: number): HostLogRow {
  const origin: HostChildOrigin = {
    background: true,
    depth,
    parentRunId: `${parentThreadId}-run`,
    parentThreadId,
    persona: 'worker',
    toolCallId: `${threadId}-call`,
    turnId: 'turn',
  };
  return { event: { origin, type: 'thread.started' }, seq: 1, threadId } as HostLogRow;
}

test('a nested subagent folded before its parent still lists under it with a family colour', () => {
  const children = new HostChildRuns();
  // Id order: the nested worker's id sorts before the worker that started it.
  for (const row of [started('0490-nested', '782a-worker', 2), started('782a-worker', 'root', 1)]) {
    children.fold(row, new Map());
  }
  const threads = new Set(['root', '782a-worker', '0490-nested']);
  const presentations = { read: () => ({}) };

  const top = children.listed('root', threads, presentations, new Map());
  const nested = children.listed('782a-worker', threads, presentations, new Map());

  expect(top.map(({ threadId }) => threadId)).toEqual(['782a-worker']);
  expect(nested.map(({ threadId }) => threadId)).toEqual(['0490-nested']);
  expect(nested[0]?.color).toBeTruthy();
  expect(nested[0]?.color).not.toBe(top[0]?.color);
});
