// @vitest-environment node
import { wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';

const databaseHolder = vi.hoisted(() => ({ current: undefined as PGlite | undefined }));
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!databaseHolder.current) {
      throw new Error('Fixture database is unavailable.');
    }
    return databaseHolder.current;
  },
}));

it('isolates the same native thread identity across replacement database owners', async () => {
  const firstDatabase = await wasmLoader.createPGlite('memory://memory-owner-before-reset');
  const secondDatabase = await wasmLoader.createPGlite('memory://memory-owner-after-reset');
  try {
    databaseHolder.current = firstDatabase;
    const first = await getDesktopMastraMemory(undefined);
    await first.store.saveThread({
      thread: {
        createdAt: new Date(),
        id: 'same-thread-id',
        resourceId: 'same-resource-id',
        title: 'Before reset',
        updatedAt: new Date(),
      },
    });
    databaseHolder.current = secondDatabase;
    const replacement = await getDesktopMastraMemory(undefined);
    expect(replacement).not.toBe(first);
    await expect(
      replacement.store.getThreadById({ threadId: 'same-thread-id' })
    ).resolves.toBeNull();
    await replacement.store.saveThread({
      thread: {
        createdAt: new Date(),
        id: 'same-thread-id',
        resourceId: 'same-resource-id',
        title: 'After reset',
        updatedAt: new Date(),
      },
    });
    await expect(getDesktopMastraMemory(undefined)).resolves.toBe(replacement);
    await expect(first.store.getThreadById({ threadId: 'same-thread-id' })).resolves.toMatchObject({
      title: 'Before reset',
    });
    await expect(
      replacement.store.getThreadById({ threadId: 'same-thread-id' })
    ).resolves.toMatchObject({ title: 'After reset' });
  } finally {
    databaseHolder.current = undefined;
    await Promise.all([firstDatabase.close(), secondDatabase.close()]);
  }
});
