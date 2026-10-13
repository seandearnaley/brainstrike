// @vitest-environment node
import type { HostAttachment } from '@brainstrike/host-lease';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { closeIndexerRuntime, getReadyIndexerHost } from '../indexer-runtime';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';
import { child, info } from './fixtures/indexer-supervisor-process';

const mocks = vi.hoisted(() => ({
  closeQueries: vi.fn(async () => {}),
  fork: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('electron', () => ({ app: { isReady: () => true }, utilityProcess: { fork: mocks.fork } }));
vi.mock('../bundled-sibling-path', () => ({
  resolveBundledSiblingPath: () => '/owned/indexer-host-entry.js',
}));
vi.mock('../db-main', () => ({ getDatabase: async () => ({ query: mocks.query }) }));
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseProfileDirectory: () => '/owned',
}));
vi.mock('../sqlite-query-host-manager', () => ({
  closeAllIndexQueries: mocks.closeQueries,
  installIndexQueryTarget: vi.fn(),
  openIndexCoverage: vi.fn(),
}));

let active: ReturnType<typeof createNativeIndexActivation> | undefined;
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  mocks.closeQueries.mockResolvedValue(undefined);
  await active?.close();
  active = undefined;
});
function fixture() {
  const profileClose = vi.fn(async () => {});
  const attachment: HostAttachment = {
    close: profileClose,
    closed: Promise.withResolvers<void>().promise,
    record: {
      endpoint: '/owned/socket',
      hostVersion: '1',
      pid: 123,
      protocolVersion: 1,
      start: 'child',
      token: 'a'.repeat(64),
    },
  };
  const storage = {
    getItem: vi.fn(async () =>
      JSON.stringify({
        state: {
          enabled: true,
          indexingPolicyPreset: 'balanced',
          managedCollectionId: null,
          nativeIndexMode: 'TEXT',
          nativeLocalSelection: null,
          paused: true,
          worktreeRootIndexingOptInById: {},
        },
      })
    ),
  };
  active = createNativeIndexActivation({
    application: {
      roots: { restoreRoots: async () => [] },
      watches: {},
    } as unknown as ApplicationIpcDomain,
    embedding: { documentEmbeddings: vi.fn() },
    onError: vi.fn(),
    profile: createDesktopProfileRuntime(() => ({
      acquire: async () => attachment,
      close: profileClose,
    })),
    storage,
  });
  return { activation: active, profileClose, storage };
}

it('fences the actual native reader immediately, joins its borrow, and rebinds before native Ready', async () => {
  const first = child();
  const second = child(true);
  mocks.fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const { activation, profileClose } = fixture();
  const initial = await activation.acquireRead();
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const read = activation.withRead(async (captured) => {
    entered.resolve();
    await held.promise;
    await expect(captured.getAuthority()).rejects.toBeDefined();
  });
  await entered.promise;
  try {
    first.emit('exit', 1);
    await expect(activation.acquireRead()).rejects.toBeDefined();
    expect(mocks.fork).toHaveBeenCalledOnce();
  } finally {
    held.resolve();
  }
  await read;
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledTimes(2));
  await expect(activation.acquireRead()).rejects.toBeDefined();
  second.emit('message', { kind: 'ready', value: info });
  await vi.waitFor(async () => expect(await activation.acquireRead()).not.toBe(initial));
  expect(profileClose).not.toHaveBeenCalled();
  first.emit('exit', 1);
  expect(await activation.acquireRead()).not.toBe(initial);
});

it('rejects an initial native acquisition before joining its loss and does not deadlock the lifecycle permit', async () => {
  const first = child(true);
  mocks.fork.mockReturnValueOnce(first).mockReturnValueOnce(child());
  const { activation } = fixture();
  const original = activation.acquireRead();
  const rejected = expect(original).rejects.toBeDefined();
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce());
  first.emit('exit', 1);
  await rejected;
  await vi.waitFor(async () => expect(await activation.acquireRead()).toBeDefined());
  expect(mocks.fork).toHaveBeenCalledTimes(2);
});

it('preserves reader cleanup failure and retries that same owner only on explicit configuration', async () => {
  const first = child();
  mocks.fork.mockReturnValueOnce(first).mockReturnValueOnce(child());
  const { activation } = fixture();
  await activation.acquireRead();
  const failure = new Error('Reader process still retained');
  const independent = new Error('Independent query cleanup failure');
  mocks.closeQueries.mockRejectedValueOnce(failure).mockRejectedValueOnce(independent);
  first.emit('exit', 1);
  await vi.waitFor(async () => {
    try {
      await activation.acquireRead();
      throw new Error('Unexpected ready');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw error;
      }
      expect(new Set(error.errors)).toEqual(new Set([failure, independent]));
    }
  });
  expect(mocks.fork).toHaveBeenCalledOnce();
  mocks.closeQueries.mockResolvedValue(undefined);
  await activation.reconfigure();
  await activation.acquireRead();
  expect(mocks.fork).toHaveBeenCalledTimes(2);
});

it('a terminal close during replacement startup joins it and never publishes another native reader', async () => {
  const first = child();
  const second = child(true);
  mocks.fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const { activation } = fixture();
  await activation.acquireRead();
  first.emit('exit', 1);
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledTimes(2));
  const exited = vi.fn();
  second.once('exit', exited);
  try {
    await activation.closeNativeOwner();
    expect(exited).toHaveBeenCalledOnce();
    await expect(activation.acquireRead()).rejects.toBeDefined();
    expect(() => getReadyIndexerHost()).toThrow();
    expect(mocks.fork).toHaveBeenCalledTimes(2);
  } finally {
    // Release a failed test's held fake process only after its physical-exit assertion.
    // This does not turn an unjoined product close into a pass.
    if (!exited.mock.calls.length) {
      second.emit('exit', 0);
    }
    await closeIndexerRuntime(async () => {});
  }
});

it('an explicit settings save supersedes loss while the old reader is still joining', async () => {
  const first = child();
  mocks.fork.mockReturnValueOnce(first).mockReturnValueOnce(child());
  const { activation, profileClose, storage } = fixture();
  await activation.acquireRead();
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const read = activation.withRead(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  first.emit('exit', 1);
  await expect(activation.acquireRead()).rejects.toBeDefined();
  storage.getItem.mockResolvedValue(
    (await storage.getItem()).replace(
      '"indexingPolicyPreset":"balanced"',
      '"indexingPolicyPreset":"full-root"'
    )
  );
  const configured = activation.reconfigure();
  const result = configured.catch((error: unknown) => error);
  held.resolve();
  await read;
  await expect(result).resolves.toBeUndefined();
  await activation.acquireRead();
  expect(profileClose).not.toHaveBeenCalled();
  first.emit('exit', 1);
  await activation.acquireRead();
  expect(mocks.fork).toHaveBeenCalledTimes(2);
});

it('a second physical loss stays failed until explicit settings action rearms its owner', async () => {
  const first = child();
  const second = child();
  mocks.fork.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(child());
  const { activation } = fixture();
  await activation.acquireRead();
  first.emit('exit', 1);
  await vi.waitFor(async () => expect(await activation.acquireRead()).toBeDefined());
  second.emit('exit', 1);
  await vi.waitFor(async () => {
    await expect(activation.acquireRead()).rejects.toMatchObject({
      cause: {
        code: 'process.lost',
        failure: { process: { child: 'index-utility', exitCode: 1 } },
      },
      code: 'native-index-source-failure',
    });
  });
  expect(mocks.fork).toHaveBeenCalledTimes(2);
  await activation.reconfigure();
  await activation.acquireRead();
  expect(mocks.fork).toHaveBeenCalledTimes(3);
});

it.each(['closeNativeOwner', 'destroyAndRetireProfile'] as const)(
  'repeated outer %s joins one actual physical generation release',
  async (operation) => {
    const process = child(false, true);
    const exited = vi.fn();
    process.once('exit', exited);
    mocks.fork.mockReturnValueOnce(process);
    const { activation } = fixture();
    await activation.acquireRead();
    const posted = vi.spyOn(process, 'postMessage');
    let complete = false;
    const closing = Promise.all([activation[operation](), activation[operation]()]).then(() => {
      complete = true;
    });
    try {
      await vi.waitFor(() =>
        expect(
          posted.mock.calls.some(([message]) => 'op' in message && message.op === 'close')
        ).toBe(true)
      );
      expect(complete).toBe(false);
      expect(exited).not.toHaveBeenCalled();
    } finally {
      process.emit('exit', 0);
    }
    await closing;
    await activation[operation]();
    expect(exited).toHaveBeenCalledOnce();
    expect(
      posted.mock.calls.filter(([message]) => 'op' in message && message.op === 'close')
    ).toHaveLength(1);
    expect(mocks.fork).toHaveBeenCalledOnce();
  }
);
