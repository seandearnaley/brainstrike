// @vitest-environment node
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createNativeIndexRuntime } from '../native-index-runtime';

it('removes the same inactive native database and sidecars before the live profile clears its content', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'brainstrike-native-content-clear-'));
  const dbPath = path.join(directory, 'index.sqlite');
  const clearContent = vi.fn(async () => {
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    return { cleared: true };
  });
  const profileClose = vi.fn(async () => undefined);
  const profile = createDesktopProfileRuntime(() => ({
    acquire: async () => ({ clearContent }),
    close: profileClose,
  }));
  const runtime = createNativeIndexRuntime({
    closeQueries: async () => undefined,
    createIndexOwner: async (authority) => {
      const starting = openIndexer(
        { ...authority, dbPath, embedding: { indexMode: 'text-only' } },
        { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
      );
      return {
        close: async () => (await starting).close(),
        databasePath: dbPath,
        destroy: async () => (await starting).destroy(),
        start: () => starting,
      };
    },
    getAuthority: async () => ({ fileBindings: [], rootIds: [], scopes: [] }),
    getFileInvalidator: () => undefined,
    installQueryTarget: () => undefined,
    profile,
  });
  try {
    await runtime.acquire();
    await runtime.closeIndex();
    await access(dbPath);
    await runtime.destroyIndex();
    expect(profileClose).not.toHaveBeenCalled();
    const attachment = await profile.acquire();
    await attachment.clearContent();
    expect(clearContent).toHaveBeenCalledOnce();
  } finally {
    await runtime.retireProfile();
    await rm(directory, { force: true, recursive: true });
  }
});
