/**
 * A thread whose history cannot be read (a row its schema no longer accepts) never fails a search: the list marks it,
 * and every readable thread still answers.
 */
import { expect, test } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import { searchHostThreads } from '../src/thread-search.js';

test('a search answers around a thread whose history cannot be read', async () => {
  const damage = 'Expected "observation" | "reflection" at ["kind"]';
  const listed = [
    { binding: null, createdAt: 1, damage, threadId: 'damaged', updatedAt: 1 },
    { binding: null, createdAt: 1, threadId: 'readable', title: 'Plan the launch', updatedAt: 1 },
  ];
  const searched: (readonly string[])[] = [];
  const core = {
    catalogEntry: (threadId: string) => {
      const {
        createdAt,
        damage: why,
        updatedAt,
      } = listed.find((t) => t.threadId === threadId) ?? {
        createdAt: 0,
        updatedAt: 0,
      };
      return { createdAt, updatedAt, ...(why === undefined ? {} : { damage: why }) };
    },
    listThreads: () => listed,
    read: (threadId: string): Promise<HostLogRow[]> =>
      threadId === 'damaged'
        ? Promise.reject(new Error(`This thread's history cannot be read: ${damage}`))
        : Promise.resolve([]),
    trees: { children: () => [] },
  } as unknown as Parameters<typeof searchHostThreads>[0];

  const found = await searchHostThreads(
    core,
    async ({ threadIds }) => {
      searched.push(threadIds);
      return threadIds.includes('damaged')
        ? [{ rank: -1, role: 'user', runId: 'run', seq: 3, snippet: 'launch', threadId: 'damaged' }]
        : [];
    },
    { query: 'launch' }
  );

  expect(searched.flat()).not.toContain('damaged');
  expect(found.results.map(({ threadId }) => threadId)).toEqual(['readable']);
});
