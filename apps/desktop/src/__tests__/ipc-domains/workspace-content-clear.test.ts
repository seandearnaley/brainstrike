import { WorkspaceRootRegistry } from '@brainstrike/assistant-service/node-workspace-services';
import { expect, it, vi } from 'vitest';
import { createStorage } from './workspace-root-registry-test-helpers';

it('clears persisted unavailable grants and last folder without deleting preferences or recents', async () => {
  const storage = createStorage({
    lastFolderPath: '/unavailable',
    preferences: 'retained-settings',
    recentRootsList: 'retained-recent-grant',
    rootsList: JSON.stringify([{ addedAt: 1, path: '/unavailable', rootId: 'unavailable-root' }]),
  });
  const getRootsCatalog = vi.fn(async () => {
    throw new Error('Retired catalog must not reopen');
  });
  const registry = new WorkspaceRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    evictLspServersForRoot: async () => undefined,
    getRootsCatalog,
    pathExists: async () => false,
    storage,
  });
  await registry.clearForContent();
  expect(await storage.getItem('rootsList')).toBe('[]');
  expect(await storage.getItem('lastFolderPath')).toBeNull();
  expect(await storage.getItem('recentRootsList')).toBe('retained-recent-grant');
  expect(await storage.getItem('preferences')).toBe('retained-settings');
  expect(getRootsCatalog).not.toHaveBeenCalled();
  expect(await registry.restoreLastFolder()).toBeNull();
  await registry.dispose();
});

it('does not claim content grants were cleared when durable storage rejects deletion', async () => {
  const failure = new Error('Workspace grant storage is unavailable');
  const storage = createStorage({ lastFolderPath: '/retained', rootsList: '[]' });
  vi.mocked(storage.removeItem).mockRejectedValue(failure);
  const registry = new WorkspaceRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    evictLspServersForRoot: async () => undefined,
    getRootsCatalog: async () => {
      throw new Error('No catalog expected');
    },
    pathExists: async () => false,
    storage,
  });
  await expect(registry.clearForContent()).rejects.toBe(failure);
  expect(storage.setItem).not.toHaveBeenCalled();
  await registry.dispose();
});
