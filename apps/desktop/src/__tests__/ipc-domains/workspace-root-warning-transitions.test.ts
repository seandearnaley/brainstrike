import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { expect, it, vi } from 'vitest';
import { createRegistry, createStorage, rootHandle } from './workspace-root-registry-test-helpers';

it('reports an unavailable saved root once per absence while preserving retries and descriptors', async () => {
  const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
  const storage = createStorage({ rootsList: JSON.stringify([entry]) });
  let exists = false;
  const pathExists = vi.fn(async () => exists);
  const registry = createRegistry({ pathExists, storage });
  const captured: LogRecord[] = [];
  const removeListener = addLogListener((record) => {
    if (record.scope === 'WorkspaceRootRegistry' && record.level === LogLevel.WARN) {
      captured.push(record);
    }
  });
  try {
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect(await registry.restoreRoots()).toMatchObject([
        { permissionState: 'unknown', rootId: entry.rootId },
      ]);
    }
    expect(captured).toHaveLength(1);
    expect(pathExists).toHaveBeenCalledTimes(7);
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
    exists = true;
    expect(await registry.restoreRoots()).toMatchObject([
      { permissionState: 'granted', rootId: entry.rootId },
    ]);
    exists = false;
    expect(await registry.restoreRoots()).toMatchObject([
      { permissionState: 'unknown', rootId: entry.rootId },
    ]);
    expect(captured).toHaveLength(2);
  } finally {
    removeListener();
    await registry.dispose();
  }
});

it('reports a new absence after a user grants the formerly unavailable saved root', async () => {
  const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
  const storage = createStorage({ rootsList: JSON.stringify([entry]) });
  const registry = createRegistry({ pathExists: async () => false, storage });
  const warnings: LogRecord[] = [];
  const removeListener = addLogListener((record) => {
    if (record.scope === 'WorkspaceRootRegistry' && record.level === LogLevel.WARN) {
      warnings.push(record);
    }
  });
  try {
    await registry.restoreRoots();
    expect(warnings).toHaveLength(1);
    expect(await registry.addRoot(rootHandle(entry.path))).toMatchObject({
      permissionState: 'granted',
      rootId: entry.rootId,
    });
    expect(await registry.restoreRoots()).toMatchObject([
      { permissionState: 'unknown', rootId: entry.rootId },
    ]);
    expect(warnings).toHaveLength(2);
    const saved = await storage.getItem('rootsList');
    if (saved === null) {
      throw new Error('Saved root identity was removed.');
    }
    expect(JSON.parse(saved)).toMatchObject([{ path: entry.path, rootId: entry.rootId }]);
  } finally {
    removeListener();
    await registry.dispose();
  }
});

it('reports mount errors independently and rearms absence after the filesystem path returns', async () => {
  const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
  const storage = createStorage({ rootsList: JSON.stringify([entry]) });
  let exists = false;
  const registry = createRegistry({
    createSecureRoot: async () => {
      throw new Error('actual mount permission failure');
    },
    pathExists: async () => exists,
    storage,
  });
  const records: LogRecord[] = [];
  const removeListener = addLogListener((record) => {
    if (record.scope === 'WorkspaceRootRegistry') {
      records.push(record);
    }
  });
  try {
    await registry.restoreRoots();
    exists = true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await registry.restoreRoots()).toMatchObject([
        { permissionState: 'unknown', rootId: entry.rootId },
      ]);
    }
    expect(records.filter((record) => record.level === LogLevel.ERROR)).toHaveLength(2);
    exists = false;
    await registry.restoreRoots();
    expect(records.filter((record) => record.level === LogLevel.WARN)).toHaveLength(2);
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
  } finally {
    removeListener();
    await registry.dispose();
  }
});

it.each(['remove', 'restore-prune'] as const)(
  'forgets a removed absence through %s before the same saved identity returns',
  async (removal) => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    const stored = JSON.stringify([entry]);
    const storage = createStorage({ rootsList: stored });
    const registry = createRegistry({ pathExists: async () => false, storage });
    const warnings: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceRootRegistry' && record.level === LogLevel.WARN) {
        warnings.push(record);
      }
    });
    try {
      await registry.restoreRoots();
      if (removal === 'remove') {
        await registry.removeRoot(entry.rootId);
      } else {
        await storage.setItem('rootsList', '[]');
        expect(await registry.restoreRoots()).toEqual([]);
      }
      expect(await storage.getItem('rootsList')).toBe('[]');
      await storage.setItem('rootsList', stored);
      expect(await registry.restoreRoots()).toMatchObject([
        { permissionState: 'unknown', rootId: entry.rootId },
      ]);
      expect(warnings).toHaveLength(2);
    } finally {
      removeListener();
      await registry.dispose();
    }
  }
);
