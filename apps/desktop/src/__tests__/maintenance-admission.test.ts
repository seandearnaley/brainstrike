import { describe, expect, it } from 'vitest';
import { readInFlightAssistantWork } from '../maintenance-admission';

// A read that cannot be trusted must never admit an unpreemptable statement:
// every malformed result throws instead of reading as "no work in flight".
describe('readInFlightAssistantWork result guards', () => {
  it.for([
    { name: 'no row', rows: [] },
    {
      name: 'two rows',
      rows: [
        { backgroundTasks: 0, runs: 0 },
        { backgroundTasks: 0, runs: 0 },
      ],
    },
    { name: 'a text count', rows: [{ backgroundTasks: 0, runs: '1' }] },
    { name: 'a negative count', rows: [{ backgroundTasks: -1, runs: 0 }] },
    { name: 'a missing count', rows: [{ runs: 0 }] },
  ])('refuses a result with $name', async ({ rows }) => {
    await expect(readInFlightAssistantWork({ query: async () => ({ rows }) })).rejects.toThrow(
      'In-flight assistant work read'
    );
  });
});
