/**
 * A thread whose history cannot be read (a row its schema no longer accepts)
 * never runs, and never stops the other threads of its resource: their Memory
 * reads around it, as a search answers around it.
 */
import { expect, test } from 'vitest';
import { HostLogProjections } from '../src/log-projections.ts';
import type { HostLogRow } from '../src/protocol.ts';

const damage = 'Expected "observation" | "reflection" at ["kind"]';
const catalog = {
  assertRunnable: (threadId: string) => {
    if (threadId === 'damaged') {
      throw new Error(`This thread's history cannot be read, so it cannot run: ${damage}`);
    }
  },
  isDamaged: (threadId: string) => threadId === 'damaged',
};

function projections(): HostLogProjections {
  const owner = new HostLogProjections();
  for (const threadId of ['damaged', 'live']) {
    owner.apply({ event: { type: 'thread.started' }, seq: 1, threadId } as HostLogRow);
  }
  return owner;
}

test('a run’s Memory reads its resource around a damaged thread', () => {
  const rows = projections().readRunnable(catalog, new Set(['damaged', 'live']), 'live');
  expect(rows.map((row) => row.threadId)).toEqual(['live']);
});

test('a run on the damaged thread itself is refused, never shortened', () => {
  expect(() => projections().readRunnable(catalog, new Set(['damaged']), 'damaged')).toThrow(
    damage
  );
});
