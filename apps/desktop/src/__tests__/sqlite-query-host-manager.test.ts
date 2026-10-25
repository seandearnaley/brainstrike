// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { ForkLentUtility } from '../lent-utility';

const mocks = {
  children: [] as Array<{
    receive(value: unknown): void;
    exit(): void;
    messages: unknown[];
    kill: ReturnType<typeof vi.fn<() => boolean>>;
  }>,
  heldStartup: false,
  refuse: false,
};
/** Main's lent reader utility, whose exit Main reports once joined (`forkLentUtility`). */
const fork: ForkLentUtility = () => {
  const messages: unknown[] = [];
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => {
      if (mocks.refuse) {
        return false;
      }
      queueMicrotask(() => child.emit('exit', 0));
      return true;
    }),
    pid: 1234,
    postMessage: (request: unknown) => {
      messages.push(request);
      if (
        !mocks.heldStartup &&
        typeof request === 'object' &&
        request !== null &&
        Reflect.get(request, 'kind') === 'open-native-coverage'
      ) {
        const id: unknown = Reflect.get(request, 'id');
        queueMicrotask(() => child.emit('message', { id, kind: 'ready' }));
      }
    },
  });
  mocks.children.push({
    exit: () => child.emit('exit', 0),
    kill: child.kill,
    messages,
    receive: (value) => child.emit('message', value),
  });
  return child;
};

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
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 }, fork);
  const reader = await manager.openIndexCoverage(authority);
  mocks.refuse = true;
  await expect(manager.closeAllIndexQueries()).rejects.toThrow(
    'Index query owners did not all exit'
  );
  expect(() =>
    manager.installIndexQueryTarget(
      () => index,
      { deadlineMs: 1000, startupDeadlineMs: 5000 },
      fork
    )
  ).toThrow('previous index query target');
  mocks.refuse = false;
  await manager.closeAllIndexQueries();
  await reader.close();
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 }, fork);
  await manager.closeAllIndexQueries();
});

it('stops and joins a held startup before reset allows a replacement owner', async () => {
  mocks.heldStartup = true;
  const manager = await import('../sqlite-query-host-manager');
  const index = { databasePath: authority.dbPath };
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 }, fork);
  const acquisition = manager.openIndexCoverage(authority).catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.children).toHaveLength(1));
  // Coverage startup has no deadline: reset is what ends it, by stopping its process.
  await manager.closeAllIndexQueries();
  expect(await acquisition).toMatchObject({ name: 'SqliteQueryProcessExitedError' });
  expect(mocks.children[0]?.kill).toHaveBeenCalledOnce();
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 }, fork);
  await manager.closeAllIndexQueries();
});

it('keeps coverage read admission owned until a held read physically exits on reset', async () => {
  const manager = await import('../sqlite-query-host-manager');
  const index = { databasePath: authority.dbPath };
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 }, fork);
  const reader = await manager.openIndexCoverage(authority);
  const pending = reader
    .nativeCoverage([{ scope: { kind: 'workspace', rootId: 'root' } }])
    .catch((error: unknown) => error);
  await manager.closeAllIndexQueries();
  expect(await pending).toBeInstanceOf(Error);
  expect(mocks.children[0]?.kill).toHaveBeenCalledOnce();
  await reader.close();
});

// Lifecycle redesign PR D: coverage is background work; a slow reader is load, not death.
it('reads coverage from a reader slower to start and to answer than any former deadline', async () => {
  vi.useFakeTimers();
  mocks.heldStartup = true;
  const manager = await import('../sqlite-query-host-manager');
  const index = { databasePath: authority.dbPath };
  manager.installIndexQueryTarget(() => index, { deadlineMs: 1000, startupDeadlineMs: 5000 }, fork);
  const acquisition = manager.openIndexCoverage(authority);
  acquisition.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(6000);
  const child = mocks.children[0];
  const open = child?.messages[0] as { readonly id: number } | undefined;
  expect(open).toBeDefined();
  child?.receive({ id: open?.id, kind: 'ready' });
  const reader = await acquisition;

  const read = reader.nativeCoverage([{ scope: { kind: 'workspace', rootId: 'root' } }]);
  read.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(6000);
  const request = child?.messages[1] as { readonly id: number } | undefined;
  child?.receive({ id: request?.id, kind: 'nativeCoverage', result: [] });
  await expect(read).resolves.toEqual([]);
  expect(child?.kill).not.toHaveBeenCalled();
  await reader.close();
  await manager.closeAllIndexQueries();
});
