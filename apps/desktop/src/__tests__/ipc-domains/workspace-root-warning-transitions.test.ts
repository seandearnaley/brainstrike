import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { expect, it, vi } from 'vitest';
import {
  createRegistry,
  listOpenRoots,
  openRootsCatalog,
  rootHandle,
} from './workspace-root-registry-test-helpers';

it('reports an unavailable saved root once per absence while preserving retries and descriptors', async () => {
  const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
  const catalog = openRootsCatalog([entry]);
  let exists = false;
  const pathExists = vi.fn(async () => exists);
  const registry = createRegistry({ pathExists }, catalog);
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
    expect(await listOpenRoots(catalog)).toEqual([{ path: entry.path, rootId: entry.rootId }]);
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
  const catalog = openRootsCatalog([entry]);
  const registry = createRegistry({ pathExists: async () => false }, catalog);
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
    expect(await listOpenRoots(catalog)).toEqual([{ path: entry.path, rootId: entry.rootId }]);
  } finally {
    removeListener();
    await registry.dispose();
  }
});

it('reports mount errors independently and rearms absence after the filesystem path returns', async () => {
  const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
  const catalog = openRootsCatalog([entry]);
  let exists = false;
  const registry = createRegistry(
    {
      createSecureRoot: async () => {
        throw new Error('actual mount permission failure');
      },
      pathExists: async () => exists,
    },
    catalog
  );
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
    expect(await listOpenRoots(catalog)).toEqual([{ path: entry.path, rootId: entry.rootId }]);
  } finally {
    removeListener();
    await registry.dispose();
  }
});

it.each(['remove', 'restore-prune'] as const)(
  'forgets a removed absence through %s before the same saved identity returns',
  async (removal) => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    const catalog = openRootsCatalog([entry]);
    const registry = createRegistry({ pathExists: async () => false }, catalog);
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
        await catalog({
          closeRootIds: [entry.rootId],
          mountedPaths: [],
          operation: 'disconnect-except',
        });
        expect(await registry.restoreRoots()).toEqual([]);
      }
      expect(await listOpenRoots(catalog)).toEqual([]);
      await catalog({
        operation: 'register',
        root: {
          canonicalPath: entry.path,
          displayName: 'workspace',
          path: entry.path,
          preferredId: entry.rootId,
        },
      });
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
