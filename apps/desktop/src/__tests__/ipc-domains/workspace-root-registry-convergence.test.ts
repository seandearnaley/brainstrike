import path from 'node:path';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { WorkspaceRootRegistry } from '../../ipc-domains/workspace-root-registry';

const records: LogRecord[] = [];
const removeListener = addLogListener((record) => {
  if (
    record.scope === 'WorkspaceRootRegistry' &&
    record.message?.startsWith('Workspace root database convergence')
  ) {
    records.push(record);
  }
});
afterEach(() => {
  records.length = 0;
});
afterAll(removeListener);

function createStorage(): ElectronStorageAdapter {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as ElectronStorageAdapter;
}

it.each([
  { expected: true, level: LogLevel.INFO, message: 'Workspace root database convergence stopped' },
  { expected: false, level: LogLevel.ERROR, message: 'Workspace root database convergence failed' },
])(
  'logs a refused convergence at the level its catalog owner expects ($expected)',
  async ({ expected, level, message }) => {
    const refused = new Error('Native index activation is closed for terminal retirement.');
    const registry = new WorkspaceRootRegistry({
      disposeCommandSessionsForRoot: vi.fn(async () => 0),
      evictLspServersForRoot: vi.fn(async () => undefined),
      getRootsCatalog: () => Promise.reject(refused),
      isExpectedCatalogRefusal: (error) => expected && error === refused,
      pathExists: async () => true,
      resolveCanonicalRoot: async (rootPath) => path.normalize(rootPath),
      storage: createStorage(),
    });

    // Removing an unknown root still converges the catalog, which refuses.
    await registry.removeRoot('unknown-root');

    expect(records.map((record) => [record.level, record.message])).toEqual([[level, message]]);
  }
);
