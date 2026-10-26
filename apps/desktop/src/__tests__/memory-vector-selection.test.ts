// @vitest-environment node
import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import { resolveDesktopMemoryVectors } from '../agent-host-platform/memory-vector-selection';
import type { PlatformSelection } from '../agent-host-platform/platform-wire';

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

function sources() {
  return {
    readDimensions: vi.fn(async (_provider: string, modelId: string) =>
      modelId === 'text-embedding-3-small' ? 1536 : 0
    ),
  };
}

test('memory without recall or vector observations resolves no profile', async () => {
  const read = sources();
  expect(
    await resolveDesktopMemoryVectors(
      settings('openai/text-embedding-3-small', { recall: false }),
      read
    )
  ).toBeUndefined();
  expect(read.readDimensions).not.toHaveBeenCalled();
});

test('a hosted recall target resolves its catalog profile', async () => {
  const read = sources();
  expect(
    await resolveDesktopMemoryVectors(settings('openai/text-embedding-3-small'), read)
  ).toEqual({
    dimensions: 1536,
    distance: 'cosine',
    modelId: 'text-embedding-3-small',
    provider: 'openai',
  });
  expect(read.readDimensions).toHaveBeenCalledWith('openai', 'text-embedding-3-small');
});

test('recall without a target refuses visibly', async () => {
  // BST-2202: no selected target is a typed configuration refusal with its remedy.
  const unselected = await resolveDesktopMemoryVectors(settings(null), sources()).catch(
    (error: unknown) => error
  );
  expect(unselected).toBeInstanceOf(BoundaryFailureError);
  expect((unselected as BoundaryFailureError).failure).toEqual({
    category: 'configuration',
    code: 'memory.configuration-invalid',
    kind: 'refusal',
    message: 'Semantic recall has no embedding model selected.',
    remedy: 'Choose an embedding model in Settings → Assistant Memory.',
  });
});
