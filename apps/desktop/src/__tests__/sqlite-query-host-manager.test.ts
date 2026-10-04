// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  children: [] as Array<{
    receive(value: unknown): void;
    exit(): void;
    messages: unknown[];
    kill: ReturnType<typeof vi.fn>;
  }>,
  heldStartup: false,
  refuse: false,
}));
vi.mock('electron', () => ({
  app: { isReady: () => true },
  utilityProcess: {
    fork: () => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      const emit = (event: string, value?: unknown): void => {
        for (const listener of listeners.get(event) ?? []) {
          listener(value);
        }
      };
      const messages: unknown[] = [];
      const kill = vi.fn(() => {
        if (mocks.refuse) {
          return false;
        }
        queueMicrotask(() => emit('exit'));
        return true;
      });
      mocks.children.push({
        exit: () => emit('exit'),
        kill,
        messages,
        receive: (value) => emit('message', value),
      });
      return {
        kill,
        off: (event: string, listener: (value: unknown) => void) => {
          listeners.get(event)?.delete(listener);
        },
        on: (event: string, listener: (value: unknown) => void) => {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
        },
        pid: 1234,
        postMessage: (request: { id: number; kind: string }) => {
          messages.push(request);
          if (!mocks.heldStartup && request.kind === 'open-native-coverage') {
            queueMicrotask(() => emit('message', { id: request.id, kind: 'ready' }));
          }
        },
      };
    },
  },
}));
vi.mock('../bundled-sibling-path', () => ({
  resolveBundledSiblingPath: () => '/actual-query-entry.js',
}));

const authority = {
  authorityEpoch: 'b'.repeat(64),
  authorityRevision: 7,
  dbPath: '/owned/index.sqlite',
  fileBindings: [],
  rootIds: [],
  scopes: [],
  storeId: 'a'.repeat(64),
};
afterEach(() => {
  vi.useRealTimers();
  mocks.children.length = 0;
  mocks.refuse = false;
  mocks.heldStartup = false;
  vi.resetModules();
});

it('retains a failed reader exit through reset and joins it on retry', async () => {
  const manager = await import('../sqlite-query-host-manager');
  const index = { databasePath: authority.dbPath };
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 });
  const reader = await manager.openIndexCoverage(authority);
  mocks.refuse = true;
  await expect(manager.closeAllIndexQueries()).rejects.toThrow(
    'Index query owners did not all exit'
  );
  expect(() =>
    manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 })
  ).toThrow('previous index query target');
  mocks.refuse = false;
  await manager.closeAllIndexQueries();
  await reader.close();
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 });
  await manager.closeAllIndexQueries();
});

it('joins a held startup before reset allows a replacement owner', async () => {
  vi.useFakeTimers();
  mocks.heldStartup = true;
  const manager = await import('../sqlite-query-host-manager');
  const index = { databasePath: authority.dbPath };
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 });
  const acquisition = manager.openIndexCoverage(authority).catch((error: unknown) => error);
  const reset = manager.closeAllIndexQueries();
  await vi.advanceTimersByTimeAsync(5001);
  expect(await acquisition).toMatchObject({ name: 'SqliteQueryDeadlineError' });
  await reset;
  expect(mocks.children[0]?.kill).toHaveBeenCalledOnce();
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 });
  await manager.closeAllIndexQueries();
});

it('keeps coverage read admission owned until a held read physically exits on reset', async () => {
  const manager = await import('../sqlite-query-host-manager');
  const index = { databasePath: authority.dbPath };
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 });
  const reader = await manager.openIndexCoverage(authority);
  const pending = reader
    .nativeCoverage([{ scope: { kind: 'workspace', rootId: 'root' } }])
    .catch((error: unknown) => error);
  await manager.closeAllIndexQueries();
  expect(await pending).toBeInstanceOf(Error);
  expect(mocks.children[0]?.kill).toHaveBeenCalledOnce();
  await reader.close();
});
