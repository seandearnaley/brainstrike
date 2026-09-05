import { expect, it, onTestFinished } from 'vitest';
import { createTestPGlite } from './helpers/test-pglite';

it('closes every in-memory database owned by a completed test', async () => {
  const databases: Awaited<ReturnType<typeof createTestPGlite>>[] = [];
  // Test-finished hooks unwind in reverse order. Observe the resource after
  // each creation's cleanup, through the real runner lifecycle.
  onTestFinished(() => {
    expect(databases.map((db) => db.closed)).toEqual([true, true]);
  });
  for (const name of ['first', 'second']) {
    const db = await createTestPGlite(`memory://test-lifecycle-${name}`);
    databases.push(db);
    expect((await db.query<{ value: number }>('SELECT 42 AS value')).rows).toEqual([{ value: 42 }]);
  }
});
