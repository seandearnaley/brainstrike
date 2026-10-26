import { INTERNAL_FAULT, refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { DEFAULT_INDEX_CONFIG } from '@brainstrike/assistant-contract/index-config';
import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { IndexerError } from '@brainstrike/indexer';
import type {
  IndexChunkBoundsCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, expect, it, vi } from 'vitest';
import { getFactoryResetUnavailableReason } from '../factory-reset-availability';
import { IndexConfigRefused, IndexConfigStoreFailed } from '../index-config';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { registerIndexSearchIpcHandlers } from '../ipc-index-search';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import { createIpcBridge } from '../platform/ipc-bridge';
import { createIpcCapability } from '../renderer/ipc-capability';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
  invokeDesktopIpc,
  invokeDesktopIpcFrom,
} from './helpers/desktop-ipc-sender-test-helpers';

const ipc = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
}));
vi.mock('electron', () => ({ ipcMain: ipc }));
const registryError = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (original) => ({
  ...(await original<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({ debug: vi.fn(), error: registryError, info: vi.fn(), warn: vi.fn() }),
}));
const unusedConfig: Parameters<typeof registerIndexSearchIpcHandlers>[2] = {
  read: async () => {
    throw new Error('Unexpected search index settings read in this test');
  },
  update: async () => {
    throw new Error('Unexpected search index settings change in this test');
  },
};
/** The read-only cases register no settings work of their own. */
function registerReadOnly(
  cap: Parameters<typeof registerIndexSearchIpcHandlers>[0],
  registration: Parameters<typeof registerIndexSearchIpcHandlers>[1]
): () => void {
  return registerIndexSearchIpcHandlers(cap, registration, unusedConfig);
}
const UNTRACKED_SENDER_ID = 78_123_456;
const dispose: Array<() => void> = [];
afterEach(() => {
  for (const fn of dispose.splice(0)) {
    fn();
  }
  vi.clearAllMocks();
});
/** Calls one index-search method on the desktop IPC connection from a trusted app window. */
function invoke(name: keyof typeof indexSearchContract, ...args: unknown[]): Promise<unknown> {
  return invokeDesktopIpc(ipc, indexSearchContract[name].channel, ...args);
}
/** Calls one index-search method from `event`'s sender. */
function invokeFrom(
  event: unknown,
  name: keyof typeof indexSearchContract,
  ...args: unknown[]
): Promise<unknown> {
  return invokeDesktopIpcFrom(ipc, event, indexSearchContract[name].channel, ...args);
}
/** The renderer's `window.indexSearch` over the one desktop IPC connection. */
function rendererIndexSearch() {
  return createIpcCapability(
    createIpcBridge(
      {
        invoke: <Result>(method: string, ...args: unknown[]) =>
          invokeDesktopIpc(ipc, method, ...args) as Promise<Result>,
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      indexSearchContract
    ),
    indexSearchContract
  );
}
function capability(): IndexSearchCapability & IndexChunkBoundsCapability {
  return {
    coverage: vi.fn(async () => {
      throw new Error('Coverage failure');
    }),
    coverageBatch: vi.fn(async () => {
      throw new Error('Unexpected coverage batch');
    }),
    fileChunks: vi.fn(async () => {
      throw new Error('Unexpected file chunks');
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
    registerReadOnly(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const bridge = rendererIndexSearch();
  await expect(bridge.coverageBatch([{ rootIds: ['root'] }])).resolves.toEqual({
    code: 'native-coverage-observation-invalidated',
    kind: 'invalidated',
  });
  vi.mocked(cap.coverageBatch).mockRejectedValueOnce(new Error(invalidation.message));
  await expect(bridge.coverageBatch([{ rootIds: ['root'] }])).rejects.toMatchObject({
    failure: INTERNAL_FAULT,
  });
});
it('serves an app window through the one IPC connection with canonical result/error unwrap', async () => {
  const cap = capability();
  dispose.push(
    registerReadOnly(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const bridge = rendererIndexSearch();
  await expect(bridge.status()).resolves.toEqual({
    kind: 'unavailable',
    reason: 'No configured index owner.',
  });
  await expect(bridge.coverage({ rootIds: ['r'] })).rejects.toMatchObject({
    failure: INTERNAL_FAULT,
  });
});
it('rejects untracked and foreign-frame senders before payload parsing or capability calls', async () => {
  const cap = capability();
  dispose.push(
    registerReadOnly(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  await expect(
    invokeFrom(
      { sender: { id: UNTRACKED_SENDER_ID }, senderFrame: createAllowlistedSenderFrame() },
      'coverage',
      null
    )
  ).rejects.toThrow('requires an app window sender');
  await expect(
    invokeFrom(
      { ...createTrustedInvokeEvent(), senderFrame: { url: 'https://foreign.example/' } },
      'coverage',
      null
    )
  ).rejects.toThrow('unrecognized sender frame URL');
  expect(cap.coverage).not.toHaveBeenCalled();
  await expect(invoke('coverage', { rootIds: ['r', 'r'] })).resolves.toEqual({
    error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
    ok: false,
  });
  expect(cap.coverage).not.toHaveBeenCalled();
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

it('parses every batch selector and preserves app-window authority and failure propagation', async () => {
  const cap = capability();
  dispose.push(
    registerReadOnly(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const requests = [{ rootIds: ['root'] }, { rootIds: ['root', 'other'] }];
  expect(indexSearchContract.coverageBatch.parseArgs([requests])).toEqual([requests]);
  expect(() => indexSearchContract.coverageBatch.parseArgs([[]])).toThrow('requires');
  expect(() =>
    indexSearchContract.coverageBatch.parseArgs([[{ rootIds: ['root', 'root'] }]])
  ).toThrow('unique');
  expect(() =>
    indexSearchContract.coverageBatch.parseArgs([[{ profile: {}, rootIds: ['root'] }]])
  ).toThrow();
  await expect(
    invokeFrom(
      { sender: { id: UNTRACKED_SENDER_ID }, senderFrame: createAllowlistedSenderFrame() },
      'coverageBatch',
      requests
    )
  ).rejects.toThrow('requires an app window sender');
  expect(cap.coverageBatch).not.toHaveBeenCalled();
  const result = await invoke('coverageBatch', requests);
  expect(result).toMatchObject({ ok: false });
  expect(cap.coverageBatch).toHaveBeenCalledExactlyOnceWith(requests);
});

it('parses file chunk requests strictly and keeps them app-window only', async () => {
  const cap = capability();
  dispose.push(
    registerReadOnly(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  const request = { paths: ['src/a.ts', '/docs/b.md'], rootId: 'root-1' };
  expect(indexSearchContract.fileChunks.parseArgs([request])).toEqual([request]);
  for (const invalid of [
    { paths: [], rootId: 'root-1' },
    { paths: Array.from({ length: 101 }, (_, index) => `f${index}.ts`), rootId: 'root-1' },
    { paths: [''], rootId: 'root-1' },
    { paths: ['a.ts'], rootId: ' ' },
    { paths: ['a.ts'], rootId: 'root-1', withContent: true },
  ]) {
    expect(() => indexSearchContract.fileChunks.parseArgs([invalid])).toThrow();
  }
  await expect(
    invokeFrom(
      { sender: { id: UNTRACKED_SENDER_ID }, senderFrame: createAllowlistedSenderFrame() },
      'fileChunks',
      request
    )
  ).rejects.toThrow('requires an app window sender');
  expect(cap.fileChunks).not.toHaveBeenCalled();
  vi.mocked(cap.fileChunks).mockResolvedValueOnce({
    files: [
      { kind: 'outside-index', path: 'src/a.ts' },
      { kind: 'not-indexed', path: '/docs/b.md' },
    ],
    rootId: 'root-1',
    storeId: 'store-1',
  });
  await expect(invoke('fileChunks', request)).resolves.toMatchObject({
    ok: true,
  });
  expect(cap.fileChunks).toHaveBeenCalledExactlyOnceWith(request);
});

it.each([
  { dimensions: 1536, distance: 'cosine', modelId: 'text-embedding-3-small', provider: 'openai' },
  { dimensions: 3072, distance: 'ip', modelId: 'text-embedding-3-large', provider: 'openai' },
  { dimensions: 3072, distance: 'cosine', modelId: 'gemini-embedding-001', provider: 'google' },
  { dimensions: 1024, distance: 'l2', modelId: 'embed-english-v3.0', provider: 'cohere' },
  { dimensions: 1024, distance: 'ip', modelId: 'voyage-3', provider: 'voyage' },
])(
  'preserves the whole $provider $dimensions $distance profile through the actual IPC parser',
  (profile) => {
    const request = {
      limit: 10,
      mode: 'vector',
      profile,
      rootIds: ['root'],
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
  'rejects a providerless profile carrying a %s distance',
  (distance) => {
    const request = {
      limit: 10,
      mode: 'vector',
      profile: { dimensions: 1536, distance, modelId: 'text-embedding-3-small' },
      rootIds: ['root'],
      vector: new Array<number>(1536).fill(0.5),
    };
    expect(() => indexSearchContract.search.parseArgs([request])).toThrow(
      'Native embedding provider is unsupported.'
    );
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
    registerReadOnly(cap, {
      rootsRegistered: async () => {
        throw new Error('Unexpected root registration in read-only test');
      },
    })
  );
  for (let poll = 0; poll < 3; poll += 1) {
    await expect(invoke('status')).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'unavailable',
        phase: 'blocked',
        reason: expect.stringContaining(original.message),
      },
    });
    await expect(invoke('coverageBatch', [{ rootIds: ['root'] }])).resolves.toMatchObject({
      ok: true,
      value: { kind: 'blocked', reason: expect.stringContaining(original.message) },
    });
  }
  expect(registryError).not.toHaveBeenCalled();
  expect(retained.cause).toBe(original);
  await expect(
    invoke('search', { limit: 10, mode: 'bm25', rootIds: ['root'], text: 'marker' })
  ).resolves.toMatchObject({ error: { code: 'native-index-source-failure' }, ok: false });
  expect(registryError).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    cause: original,
    code: 'native-index-source-failure',
    correlationId: expect.any(String),
  });
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
  dispose.push(registerReadOnly(capability(), { rootsRegistered }));
  await expect(
    invokeFrom(
      { sender: { id: UNTRACKED_SENDER_ID }, senderFrame: createAllowlistedSenderFrame() },
      'rootsRegistered'
    )
  ).rejects.toThrow('requires an app window sender');
  await expect(invoke('rootsRegistered', { rootId: 'renderer-claim' })).resolves.toEqual({
    error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
    ok: false,
  });
  expect(rootsRegistered).not.toHaveBeenCalled();
  const settled = vi.fn();
  const response = invoke('rootsRegistered').then(settled);
  await vi.waitFor(() => expect(rootsRegistered).toHaveBeenCalledExactlyOnceWith());
  expect(settled).not.toHaveBeenCalled();
  pending.resolve();
  await response;
  expect(settled).toHaveBeenCalledWith({ ok: true, value: undefined });
});

it('preserves the canonical failure envelope for registration failures', async () => {
  const failure = new Error('Root registration activation failed');
  dispose.push(
    registerReadOnly(capability(), {
      rootsRegistered: vi.fn(async () => {
        throw failure;
      }),
    })
  );
  await expect(invoke('rootsRegistered')).resolves.toMatchObject({
    error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
    ok: false,
  });
});

it('carries the lifecycle transition tag across IPC without logging a failed index', async () => {
  const cap = capability();
  vi.mocked(cap.search).mockRejectedValue(
    new NativeAuthorityTransitionError('Native index is transitioning.')
  );
  dispose.push(registerReadOnly(cap, { rootsRegistered: async () => {} }));
  await expect(
    invoke('search', {
      limit: 5,
      mode: 'bm25',
      rootIds: ['root'],
      text: 'test',
    })
  ).resolves.toMatchObject({
    error: { category: 'availability', code: 'native-index-transitioning', kind: 'refusal' },
    ok: false,
  });
  expect(registryError).not.toHaveBeenCalled();
});

it("hands the renderer's settings change to Main's config owner undecoded and returns the saved config", async () => {
  const saved = { ...DEFAULT_INDEX_CONFIG, paused: true };
  const config = {
    read: vi.fn(async () => DEFAULT_INDEX_CONFIG),
    update: vi.fn(async () => saved),
  };
  dispose.push(
    registerIndexSearchIpcHandlers(capability(), { rootsRegistered: async () => {} }, config)
  );
  await expect(invoke('readConfig')).resolves.toEqual({
    ok: true,
    value: DEFAULT_INDEX_CONFIG,
  });
  // Main decodes the change; the IPC boundary passes whatever the renderer sent.
  const change = { mode: 'semantic', unexpected: true };
  await expect(invoke('updateConfig', change)).resolves.toEqual({
    ok: true,
    value: saved,
  });
  expect(config.update).toHaveBeenCalledExactlyOnceWith(change);
});

/** The renderer's `window.indexSearch`, over the handlers registered with this owner. */
function rendererWithConfigOwner(update: (patch: unknown) => Promise<never>) {
  dispose.push(
    registerIndexSearchIpcHandlers(
      capability(),
      { rootsRegistered: async () => {} },
      {
        read: unusedConfig.read,
        update,
      }
    )
  );
  return rendererIndexSearch();
}

it("shows the config owner's refusal sentence in Settings", async () => {
  const renderer = rendererWithConfigOwner(async () => {
    throw new IndexConfigRefused({ message: 'Choose an embedding model first.' });
  });
  await expect(renderer.updateConfig({ mode: 'semantic' })).rejects.toMatchObject({
    failure: {
      category: 'input',
      code: 'index-config.refused',
      kind: 'refusal',
      message: 'Choose an embedding model first.',
    },
  });
  expect(registryError).not.toHaveBeenCalled();
});

it('shows a settings store failure with its remedy and the reference its cause is logged under', async () => {
  const cause = new Error('/private/profile/state.sqlite: database disk image is malformed');
  const renderer = rendererWithConfigOwner(async () => {
    throw new IndexConfigStoreFailed({
      cause,
      message: 'The search index settings could not be saved.',
    });
  });
  const failure = await renderer.updateConfig({ paused: true }).then(
    () => undefined,
    (error: unknown) => (error as { readonly failure: unknown }).failure
  );
  const factoryReset = getFactoryResetUnavailableReason(process.platform) === undefined;
  expect(failure).toEqual({
    category: 'internal',
    code: 'index-config.store-failed',
    correlationId: expect.any(String),
    kind: 'fault',
    message: 'The search index settings could not be saved.',
    ...(factoryReset ? { remedy: expect.stringContaining('Factory Reset in Settings') } : {}),
  });
  expect(JSON.stringify(failure)).not.toContain('/private/profile');
  expect(registryError).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    expect.objectContaining({
      cause,
      correlationId: (failure as { readonly correlationId: string }).correlationId,
    })
  );
});

it("shows the host's own refusal when the settings store refused the change", async () => {
  const closing = refusalError('availability', 'host.closing', 'The agent host is closing.');
  const renderer = rendererWithConfigOwner(async () => {
    throw new IndexConfigStoreFailed({
      cause: closing,
      message: 'The search index settings could not be saved.',
    });
  });
  await expect(renderer.updateConfig({ paused: true })).rejects.toMatchObject({
    failure: closing.failure,
  });
  expect(registryError).not.toHaveBeenCalled();
});
