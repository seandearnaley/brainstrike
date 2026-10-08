// @vitest-environment node
import type { SelectedEmbeddingRequestPlan } from '@brainstrike/embeddings/inference-plan';
import { vectorProfileHash } from '@brainstrike/indexer';
import { expect, test, vi } from 'vitest';
import { resolveDesktopMemoryVectors } from '../agent-host-platform/memory-vector-selection';
import type { PlatformSelection } from '../agent-host-platform/platform-wire';

const localModel = 'Xenova/all-MiniLM-L6-v2';
const savedLocal: SelectedEmbeddingRequestPlan = {
  device: 'wasm',
  dimensions: 384,
  dtype: 'q8',
  modelId: localModel,
  revision: 'e'.repeat(40),
};

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

function sources(selection: SelectedEmbeddingRequestPlan | undefined) {
  return {
    readDimensions: vi.fn(async (provider: string, modelId: string) =>
      provider === 'local' ? 384 : modelId === 'text-embedding-3-small' ? 1536 : 0
    ),
    readLocalSelection: vi.fn(async () => selection),
  };
}

test('memory without recall or vector observations resolves no profile', async () => {
  const read = sources(savedLocal);
  expect(
    await resolveDesktopMemoryVectors(settings(`local/${localModel}`, { recall: false }), read)
  ).toBeUndefined();
  expect(read.readDimensions).not.toHaveBeenCalled();
});

test('a hosted recall target resolves its catalog profile and no local plan', async () => {
  const read = sources(savedLocal);
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
  expect(read.readLocalSelection).not.toHaveBeenCalled();
});

test('local vector observations use the saved local execution plan without a token cap', async () => {
  const resolved = await resolveDesktopMemoryVectors(
    settings(`local/${localModel}`, { recall: false, vectorObservations: true }),
    sources(savedLocal)
  );
  expect(resolved).toEqual({
    local: {
      modelKey: `local::${localModel}`,
      workerPlan: savedLocal,
    },
    profile: {
      dimensions: 384,
      distance: 'cosine',
      dtype: 'q8',
      modelId: localModel,
      provider: 'local',
      revision: savedLocal.revision,
    },
  });
  // The indexer accepts this profile; another revision is another partition.
  const profile = resolved?.profile;
  if (!profile) {
    throw new Error('A local profile is required');
  }
  expect(vectorProfileHash(profile)).not.toBe(
    vectorProfileHash({ ...profile, revision: 'f'.repeat(40) })
  );
});

test('local recall without matching saved execution settings refuses visibly', async () => {
  await expect(
    resolveDesktopMemoryVectors(settings(`local/${localModel}`), sources(undefined))
  ).rejects.toThrow(/Search & Indexing/);
  await expect(
    resolveDesktopMemoryVectors(
      settings(`local/${localModel}`),
      sources({ ...savedLocal, modelId: 'Xenova/bge-small-en-v1.5' })
    )
  ).rejects.toThrow(/disagrees/);
  await expect(resolveDesktopMemoryVectors(settings(null), sources(savedLocal))).rejects.toThrow(
    /embedding model target/
  );
});
