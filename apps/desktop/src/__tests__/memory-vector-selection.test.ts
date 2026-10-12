// @vitest-environment node
import { vectorProfileHash } from '@brainstrike/indexer';
import { expect, test, vi } from 'vitest';
import {
  readEmbeddingHostDevice,
  resolveDesktopMemoryVectors,
} from '../agent-host-platform/memory-vector-selection';
import type { PlatformSelection } from '../agent-host-platform/platform-wire';
import type { EmbeddingHostStatus } from '../embedding-host-shared';

// Not the Search & Indexing model: local recall never depends on that selection.
const localModel = 'Xenova/all-MiniLM-L6-v2';

function settings(
  embeddingModelTarget: string | null,
  options: { readonly recall?: boolean; readonly vectorObservations?: boolean } = {}
): PlatformSelection['memory']['settings'] {
  return {
    observationalMemory: {
      enabled: options.vectorObservations === true,
      messageTokens: 30_000,
      modelTarget: 'openai/gpt-4.1-mini',
      observationTokens: 40_000,
      retrievalMode: options.vectorObservations ? 'vector' : 'off',
      scope: 'thread',
    },
    semanticRecall: {
      embeddingModelTarget,
      enabled: options.recall ?? true,
      messageRange: 2,
      scope: 'resource',
      topK: 5,
    },
  };
}

function sources(device: Promise<'webgpu' | 'wasm'>) {
  return {
    readDimensions: vi.fn(async (provider: string, modelId: string) =>
      provider === 'local' ? 384 : modelId === 'text-embedding-3-small' ? 1536 : 0
    ),
    readLocalDevice: vi.fn(() => device),
  };
}

test('memory without recall or vector observations resolves no profile', async () => {
  const read = sources(Promise.resolve('webgpu'));
  expect(
    await resolveDesktopMemoryVectors(settings(`local/${localModel}`, { recall: false }), read)
  ).toBeUndefined();
  expect(read.readDimensions).not.toHaveBeenCalled();
});

test('a hosted recall target resolves its catalog profile and no local plan', async () => {
  const read = sources(Promise.resolve('webgpu'));
  expect(
    await resolveDesktopMemoryVectors(settings('openai/text-embedding-3-small'), read)
  ).toEqual({
    profile: {
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    },
  });
  expect(read.readLocalDevice).not.toHaveBeenCalled();
});

test('local recall pins the embedding host unpinned load of any local model', async () => {
  const resolved = await resolveDesktopMemoryVectors(
    settings(`local/${localModel}`),
    sources(Promise.resolve('webgpu'))
  );
  const workerPlan = { device: 'webgpu', dimensions: 384, dtype: 'fp16', modelId: localModel };
  expect(resolved).toEqual({
    local: { modelKey: `local::${localModel}`, workerPlan },
    profile: {
      dimensions: 384,
      distance: 'cosine',
      dtype: 'fp16',
      modelId: localModel,
      provider: 'local',
    },
  });
});

test('a host now on WASM re-pins recall to another profile instead of mixing vectors', async () => {
  const webgpu = await resolveDesktopMemoryVectors(
    settings(`local/${localModel}`, { recall: false, vectorObservations: true }),
    sources(Promise.resolve('webgpu'))
  );
  const wasm = await resolveDesktopMemoryVectors(
    settings(`local/${localModel}`, { recall: false, vectorObservations: true }),
    sources(Promise.resolve('wasm'))
  );
  expect(wasm?.local?.workerPlan).toEqual({
    device: 'wasm',
    dimensions: 384,
    dtype: 'q4',
    modelId: localModel,
  });
  if (!(webgpu && wasm)) {
    throw new Error('Both local profiles are required');
  }
  // The indexer partitions vectors by profile hash: another dtype is another partition.
  expect(vectorProfileHash(wasm.profile)).not.toBe(vectorProfileHash(webgpu.profile));
});

test('local recall without a host device or a target refuses visibly', async () => {
  await expect(
    resolveDesktopMemoryVectors(
      settings(`local/${localModel}`),
      sources(Promise.reject(new Error('Embedding host is not running.')))
    )
  ).rejects.toThrow('Embedding host is not running.');
  await expect(
    resolveDesktopMemoryVectors(settings(null), sources(Promise.resolve('webgpu')))
  ).rejects.toThrow(/embedding model target/);
});

function hostStatus(
  state: EmbeddingHostStatus['state'],
  extra: Partial<EmbeddingHostStatus> = {}
): EmbeddingHostStatus {
  return {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host:runtime-1',
    runtimeKind: 'embedding-host',
    state,
    ...extra,
  } as EmbeddingHostStatus;
}

test('the host device is the one the running embedding host resolved at start', async () => {
  const runtime = {
    actualWorkerMetadata: null,
    backendMismatch: false,
    hostDevice: 'wasm',
    selectedDevicePreference: 'webgpu',
    telemetry: {},
  } as unknown as NonNullable<EmbeddingHostStatus['embeddingRuntime']>;
  const ensureStarted = vi.fn(async () => hostStatus('running', { embeddingRuntime: runtime }));
  await expect(
    readEmbeddingHostDevice({ ensureStarted }, new AbortController().signal)
  ).resolves.toBe('wasm');
  expect(ensureStarted).toHaveBeenCalledWith({ waitForRunning: true });
});

test('a host that cannot resolve a device refuses with its own reason', async () => {
  const signal = new AbortController().signal;
  await expect(
    readEmbeddingHostDevice(
      {
        ensureStarted: async () =>
          hostStatus('error', { lastError: 'Workspace Index requires WebGPU.' }),
      },
      signal
    )
  ).rejects.toThrow('Workspace Index requires WebGPU.');
  await expect(
    readEmbeddingHostDevice({ ensureStarted: async () => hostStatus('running') }, signal)
  ).rejects.toThrow('The embedding host has not resolved its execution device.');
});
