import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveAssistantOperatingRootBinding } from '../assistant-operating-root';

describe('resolveAssistantOperatingRootBinding', () => {
  it('binds the mounted adapter root to the durable live DB root id for its path', async () => {
    const database = {
      query: vi.fn(async () => ({ rows: [{ id: 'db-root-a' }] })),
    } as unknown as DbHandle;

    await expect(
      resolveAssistantOperatingRootBinding(database, {
        displayName: 'ProjectA',
        path: '/workspace-a',
      })
    ).resolves.toEqual({
      displayName: 'ProjectA',
      path: '/workspace-a',
      rootId: 'db-root-a',
    });
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("status = 'live'"), [
      '/workspace-a',
    ]);
  });

  it('fails visibly when the mounted root has no live durable DB identity', async () => {
    const database = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as DbHandle;

    await expect(
      resolveAssistantOperatingRootBinding(database, {
        displayName: 'ProjectA',
        path: '/workspace-a',
      })
    ).rejects.toThrow('ProjectA');
  });
});
