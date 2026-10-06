import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, expect, it, vi } from 'vitest';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { registerIndexSearchIpcHandlers } from '../ipc-index-search';
import { NativeCoverageObservationInvalidatedError } from '../native-coverage-observation-invalidated';
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
  const invalidation = new NativeCoverageObservationInvalidatedError();
  vi.mocked(cap.coverageBatch).mockResolvedValueOnce({
    code: invalidation.code,
    kind: 'invalidated',
  });
  dispose.push(registerIndexSearchIpcHandlers(cap));
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
  dispose.push(registerIndexSearchIpcHandlers(cap));
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
  dispose.push(registerIndexSearchIpcHandlers(cap));
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
  dispose.push(registerIndexSearchIpcHandlers(cap));
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
