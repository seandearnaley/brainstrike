import {
  WorkspaceRootRegistry,
  type WorkspaceRootStorage,
} from '@brainstrike/assistant-service/node-workspace-services';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

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

function createStorage(): WorkspaceRootStorage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

it.each([
  { expected: true, level: LogLevel.INFO, message: 'Workspace root database convergence stopped' },
  { expected: false, level: LogLevel.ERROR, message: 'Workspace root database convergence failed' },
])(
  'logs a refused convergence at the level its catalog owner expects ($expected)',
  async ({ expected, level, message }) => {
    const refused = new Error('The profile is closed for terminal retirement.');
    const registry = new WorkspaceRootRegistry({
      disposeCommandSessionsForRoot: vi.fn(async () => 0),
      evictLspServersForRoot: vi.fn(async () => undefined),
      // The open folders, worktrees and scratch folders read; the convergence after the restore
      // is refused.
      getRootsCatalog: async () => ({
        workspaceRoots: async (request) => {
          if (
            request.operation === 'list-open' ||
            request.operation === 'list-worktrees' ||
            request.operation === 'list-scratch' ||
            request.operation === 'list'
          ) {
            return { roots: [] };
          }
          throw refused;
        },
      }),
      isExpectedCatalogRefusal: (error) => expected && error === refused,
      pathExists: async () => true,
      recents: createStorage(),
    });

    // A restore converges the catalog to the mounted folders, which the catalog refuses.
    await registry.restoreRoots();

    expect(records.map((record) => [record.level, record.message])).toEqual([[level, message]]);
  }
);
