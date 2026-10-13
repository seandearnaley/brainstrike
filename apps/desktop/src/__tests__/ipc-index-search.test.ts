import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { IndexerError } from '@brainstrike/indexer';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, expect, it, vi } from 'vitest';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { registerIndexSearchIpcHandlers } from '../ipc-index-search';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { createIpcBridge } from '../platform/ipc-bridge';
import { createTrustedInvokeEvent } from './helpers/desktop-ipc-sender-test-helpers';

const ipc = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  on: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: ipc }));
const registryError = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (original) => ({
  ...(await original<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({ debug: vi.fn(), error: registryError, info: vi.fn(), warn: vi.fn() }),
}));
const dispose: Array<() => void> = [];
afterEach(() => {
  for (const fn of dispose.splice(0)) {
    fn();
  }
  vi.clearAllMocks();
});
function handler(name: keyof typeof indexSearchContract) {
  const entry = ipc.handle.mock.calls.find(
    ([channel]) => channel === indexSearchContract[name].channel
  );
  if (!entry) {
    throw new Error('Expected registered native index channel.');
  }
  return entry[1];
}
function capability(): IndexSearchCapability {
  return {
    coverage: vi.fn(async () => {
      throw new Error('Coverage failure');
    }),
    coverageBatch: vi.fn(async () => {
      throw new Error('Unexpected coverage batch');
    }),
    grep: vi.fn(async () => {
      throw new Error('Grep failure');
    }),
    rebuild: vi.fn(async () => {}),
    search: vi.fn(async () => {
      throw new Error('Search failure');
    }),
    status: vi.fn(async () => ({
      kind: 'unavailable' as const,
      reason: 'No configured index owner.',
    })),
  };
}
it('preserves invalid observations as data while unrelated failures keep the canonical error envelope', async () => {
  const cap = capability();
  const invalidation = new NativeAuthorityTransitionError(
    'Native source or saved profile changed during search.'
  );
  vi.mocked(cap.coverageBatch).mockResolvedValueOnce({
    code: 'native-coverage-observation-invalidated',
    kind: 'invalidated',
  });
  dispose.push(
    registerIndexSearchIpcHandlers(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const bridge = createIpcBridge(
    {
      invoke: (channel, ...args) => {
        const entry = ipc.handle.mock.calls.find(([name]) => name === channel);
        if (!entry) {
          throw new Error('Unknown channel');
        }
        return Promise.resolve(entry[1](createTrustedInvokeEvent(), ...args));
      },
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    indexSearchContract
  );
  await expect(bridge.coverageBatch([{ rootIds: ['root'] }])).resolves.toEqual({
    code: 'native-coverage-observation-invalidated',
    kind: 'invalidated',
  });
  vi.mocked(cap.coverageBatch).mockRejectedValueOnce(new Error(invalidation.message));
  await expect(bridge.coverageBatch([{ rootIds: ['root'] }])).rejects.toMatchObject({
    category: 'native-index',
    code: 'native-index-failed',
  });
});
it('uses the visible-ui authorized manifest and canonical preload result/error unwrap', async () => {
  const cap = capability();
  dispose.push(
    registerIndexSearchIpcHandlers(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const bridge = createIpcBridge(
    {
      invoke: async (channel, ...args) => {
        const entry = ipc.handle.mock.calls.find(([name]) => name === channel);
        if (!entry) {
          throw new Error('Unknown channel');
        }
        return entry[1](createTrustedInvokeEvent(), ...args);
      },
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    indexSearchContract
  );
  await expect(bridge.status()).resolves.toEqual({
    kind: 'unavailable',
    reason: 'No configured index owner.',
  });
  await expect(bridge.coverage({ rootIds: ['r'] })).rejects.toThrow('Coverage failure');
});
it('rejects hidden, untracked and foreign-frame senders before payload parsing or capability calls', async () => {
  const cap = capability();
  dispose.push(
    registerIndexSearchIpcHandlers(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const invoke = handler('coverage');
  await expect(invoke(createTrustedInvokeEvent('embedding-host'), null)).rejects.toThrow();
  await expect(
    invoke(
      { sender: { id: 78_123_456 }, senderFrame: createTrustedInvokeEvent().senderFrame },
      null
    )
  ).rejects.toThrow();
  await expect(
    invoke(
      { ...createTrustedInvokeEvent(), senderFrame: { url: 'https://foreign.example/' } },
      null
    )
  ).rejects.toThrow();
  expect(cap.coverage).not.toHaveBeenCalled();
  await expect(invoke(createTrustedInvokeEvent(), { rootIds: ['r', 'r'] })).rejects.toThrow(
    'unique'
  );
});
it('preserves explicit grep options and refuses incomplete or mixed vector profiles', () => {
  const request = {
    caseSensitive: true,
    isRegex: true,
    limit: 100,
    pattern: '\\bword\\b',
    rootIds: ['r'],
  };
  expect(indexSearchContract.grep.parseArgs([request])).toEqual([request]);
  expect(() =>
    indexSearchContract.search.parseArgs([
      { limit: 10, mode: 'vector', profile: {}, rootIds: ['r'], vector: [] },
    ])
  ).toThrow();
  expect(() =>
    indexSearchContract.search.parseArgs([
      { limit: 10, mode: 'bm25', rootIds: ['r'], text: 'x', vector: [] },
    ])
  ).toThrow();
});

it('parses every batch selector and preserves visible-ui authority and failure propagation', async () => {
  const cap = capability();
  dispose.push(
    registerIndexSearchIpcHandlers(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const requests = [{ collectionId: 'collection', rootIds: [] }, { rootIds: ['root'] }];
  expect(indexSearchContract.coverageBatch.parseArgs([requests])).toEqual([requests]);
  expect(() => indexSearchContract.coverageBatch.parseArgs([[]])).toThrow('requires');
  expect(() =>
    indexSearchContract.coverageBatch.parseArgs([[{ rootIds: ['root', 'root'] }]])
  ).toThrow('unique');
  expect(() =>
    indexSearchContract.coverageBatch.parseArgs([[{ profile: {}, rootIds: ['root'] }]])
  ).toThrow();
  await expect(
    handler('coverageBatch')(createTrustedInvokeEvent('embedding-host'), requests)
  ).rejects.toThrow();
  expect(cap.coverageBatch).not.toHaveBeenCalled();
  const result = await handler('coverageBatch')(createTrustedInvokeEvent(), requests);
  expect(result).toMatchObject({ ok: false });
  expect(cap.coverageBatch).toHaveBeenCalledExactlyOnceWith(requests);
});

it.each([
  {
    dimensions: 768,
    distance: 'cosine',
    dtype: 'q8',
    modelId: 'Xenova/bge-base-en-v1.5',
    provider: 'local',
  },
  {
    dimensions: 768,
    distance: 'l2',
    dtype: 'q4',
    modelId: 'jinaai/jina-embeddings-v2-base-code',
    provider: 'transformers',
  },
  { dimensions: 3072, distance: 'ip', modelId: 'text-embedding-3-large', provider: 'openai' },
  { dimensions: 3072, distance: 'cosine', modelId: 'gemini-embedding-001', provider: 'google' },
  { dimensions: 10, distance: 'l2', modelId: 'existing-model', provider: 'ollama' },
])(
  'preserves the whole $provider $dimensions $distance profile through the actual IPC parser',
  (profile) => {
    const request = {
      collectionId: 'existing-set',
      limit: 10,
      mode: 'vector',
      profile,
      rootIds: [],
      vector: new Array<number>(profile.dimensions).fill(0.5),
    };
    expect(indexSearchContract.search.parseArgs([request])).toEqual([request]);
    for (const invalid of [
      { vector: request.vector.slice(1) },
      { vector: [...request.vector.slice(1), Number.NaN] },
      { profile: { ...profile, unexpected: true } },
      { profile: { ...profile, revision: 'main' } },
    ]) {
      expect(() => indexSearchContract.search.parseArgs([{ ...request, ...invalid }])).toThrow();
    }
  }
);

it.each(['cosine', 'l2', 'ip'] as const)(
  'rejects providerless legacy profiles carrying an unhashed %s distance',
  (distance) => {
    const profile = {
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/bge-small-en-v1.5',
      revision: 'a'.repeat(40),
      tokenCap: 512,
    };
    const request = {
      collectionId: 'existing-set',
      limit: 10,
      mode: 'vector',
      profile,
      rootIds: [],
      vector: new Array<number>(384).fill(0.5),
    };
    expect(indexSearchContract.search.parseArgs([request])).toEqual([request]);
    expect(() =>
      indexSearchContract.search.parseArgs([{ ...request, profile: { ...profile, distance } }])
    ).toThrow('canonical embedding provider');
  }
);

it('observes a retained startup failure as stable blocked data without logging another IPC failure per poll', async () => {
  const original = new IndexerError(
    'indexer-startup-timeout',
    'Indexer startup exceeded its caller-provided deadline.'
  );
  const retained = new NativeIndexRefusalError(
    { kind: 'source-failure', message: original.message },
    original.message,
    { cause: original }
  );
  const cap = createNativeScopedSearchCapability({
    openQuery: vi.fn(),
    rebuild: vi.fn(),
    withRead: async () => {
      throw retained;
    },
  });
  dispose.push(
    registerIndexSearchIpcHandlers(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const event = createTrustedInvokeEvent();
  for (let poll = 0; poll < 3; poll += 1) {
    await expect(handler('status')(event)).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'unavailable',
        phase: 'blocked',
        reason: expect.stringContaining(original.message),
      },
    });
    await expect(handler('coverageBatch')(event, [{ rootIds: ['root'] }])).resolves.toMatchObject({
      ok: true,
      value: { kind: 'blocked', reason: expect.stringContaining(original.message) },
    });
  }
  expect(registryError).not.toHaveBeenCalled();
  expect(retained.cause).toBe(original);
  await expect(
    handler('search')(event, { limit: 10, mode: 'bm25', rootIds: ['root'], text: 'marker' })
  ).resolves.toMatchObject({ error: { code: 'native-index-source-failure' }, ok: false });
  expect(registryError).not.toHaveBeenCalled();
  await expect(cap.coverage({ rootIds: ['root'] })).rejects.toThrow(original.message);
});

it.each([
  new Error('Indexer startup exceeded its caller-provided deadline.'),
  new AggregateError(
    [
      new NativeIndexRefusalError(
        { kind: 'source-failure', message: 'retained startup' },
        'retained startup',
        { cause: new Error('retained startup') }
      ),
      new Error('close failed'),
    ],
    'Independent cleanup failed.'
  ),
])('keeps independent observation errors fatal: %s', async (failure) => {
  const cap = createNativeScopedSearchCapability({
    openQuery: vi.fn(),
    rebuild: vi.fn(),
    withRead: async () => {
      throw failure;
    },
  });
  await expect(cap.status()).rejects.toBe(failure);
  await expect(cap.coverageBatch([{ rootIds: ['root'] }])).rejects.toBe(failure);
});

it('accepts only an authorized no-argument registration notification and joins its acknowledgement', async () => {
  const pending = Promise.withResolvers<void>();
  const rootsRegistered = vi.fn(() => pending.promise);
  dispose.push(registerIndexSearchIpcHandlers(capability(), { rootsRegistered }));
  const invoke = handler('rootsRegistered');
  await expect(invoke(createTrustedInvokeEvent('embedding-host'))).rejects.toThrow();
  await expect(
    invoke({ sender: { id: 78_123_456 }, senderFrame: createTrustedInvokeEvent().senderFrame })
  ).rejects.toThrow();
  await expect(invoke(createTrustedInvokeEvent(), { rootId: 'renderer-claim' })).rejects.toThrow();
  expect(rootsRegistered).not.toHaveBeenCalled();
  const settled = vi.fn();
  const response = Promise.resolve(invoke(createTrustedInvokeEvent())).then(settled);
  await vi.waitFor(() => expect(rootsRegistered).toHaveBeenCalledExactlyOnceWith());
  expect(settled).not.toHaveBeenCalled();
  pending.resolve();
  await response;
  expect(settled).toHaveBeenCalledWith({ ok: true, value: undefined });
});

it('preserves the canonical failure envelope for registration failures', async () => {
  const failure = new Error('Root registration activation failed');
  dispose.push(
    registerIndexSearchIpcHandlers(capability(), {
      rootsRegistered: vi.fn(async () => {
        throw failure;
      }),
    })
  );
  await expect(handler('rootsRegistered')(createTrustedInvokeEvent())).resolves.toMatchObject({
    error: { category: 'native-index', code: 'native-index-failed', message: failure.message },
    ok: false,
  });
});

it('carries the lifecycle transition tag across IPC without logging a failed index', async () => {
  const cap = capability();
  vi.mocked(cap.search).mockRejectedValue(
    new NativeAuthorityTransitionError('Native index is transitioning.')
  );
  dispose.push(registerIndexSearchIpcHandlers(cap, { rootsRegistered: async () => {} }));
  await expect(
    handler('search')(createTrustedInvokeEvent(), {
      limit: 5,
      mode: 'bm25',
      rootIds: ['root'],
      text: 'test',
    })
  ).resolves.toMatchObject({
    error: { category: 'native-index', code: 'native-index-transitioning' },
    ok: false,
  });
  expect(registryError).not.toHaveBeenCalled();
});
