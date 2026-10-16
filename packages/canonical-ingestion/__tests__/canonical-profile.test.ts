// @vitest-environment node
import { projectModelCatalog } from '@brainstrike/assistant-contract';
import type { CollectionRecord } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import {
  NativeCanonicalInference,
  NativeCanonicalProfileResolver,
  resolveNativeCanonicalProfile,
} from '../src/canonical-profile.js';
import type { CanonicalOperationContext, CanonicalSourceScope } from '../src/ports.js';

// The seams a host fills: its setup refusal and its hosted embeddings. Desktop's own composition is
// covered by its native-canonical-profile suites.
const local = {
  dimensions: 384,
  distance: 'cosine',
  id: 'collection',
  modelId: 'Xenova/bge-small-en-v1.5',
  modelKey: 'local::Xenova/bge-small-en-v1.5',
} as const;
const hosted = {
  ...local,
  dimensions: 4,
  modelId: 'saved-model',
  modelKey: 'openai::saved-model',
} as const;
const scope: CanonicalSourceScope = { embeddingSetId: local.id, kind: 'collection' };
const context = (): CanonicalOperationContext => ({
  requestId: 'resolve',
  signal: new AbortController().signal,
});
const row = (saved: typeof local | typeof hosted): CollectionRecord => ({
  ...saved,
  createdAt: '2026-10-16T00:00:00.000Z',
});
const SETUP = 'Choose local model execution in Search & Indexing settings.';

class HostSetupRequired extends Error {}

function resolver(saved: typeof local | typeof hosted, setupRequired?: (message: string) => Error) {
  return new NativeCanonicalProfileResolver({
    collections: { collections: async () => ({ collections: [row(saved)] }) },
    modelCatalog: { read: async () => projectModelCatalog({ models: [], providers: [] }) },
    readLocalSelection: async () => undefined,
    resolveEmbeddingSetId: async () => saved.id,
    ...(setupRequired ? { setupRequired } : {}),
  });
}

describe('canonical profile host seams', () => {
  it('refuses a local model with no execution chosen, with the host refusal when given one', async () => {
    expect(() => resolveNativeCanonicalProfile(local)).toThrow(SETUP);
    expect(() =>
      resolveNativeCanonicalProfile(
        local,
        undefined,
        undefined,
        (message) => new HostSetupRequired(message)
      )
    ).toThrow(HostSetupRequired);

    await expect(resolver(local).resolve(scope, context())).rejects.toThrow(SETUP);
    const refusal = resolver(local, (message) => new HostSetupRequired(message)).resolve(
      scope,
      context()
    );
    await expect(refusal).rejects.toBeInstanceOf(HostSetupRequired);
    await expect(refusal).rejects.toThrow(SETUP);
  });

  it('refuses a hosted profile when the host gives no hosted embeddings', async () => {
    const documentEmbeddings = vi.fn(async () => [[1]]);
    const inference = new NativeCanonicalInference({
      resolver: resolver(hosted),
      scope,
      transport: { documentEmbeddings },
    });
    await expect(
      inference.generate({
        chunks: [{ chunkId: 'chunk', content: 'text' }],
        profile: resolveNativeCanonicalProfile(hosted).profile,
        requestId: 'hosted',
      })
    ).rejects.toThrow('Canonical inference execution is unsupported for provider openai.');
    expect(documentEmbeddings).not.toHaveBeenCalled();
    await inference.close();
  });

  it('embeds a hosted profile through the hosted embeddings the host gives', async () => {
    const hostedEmbeddings = vi.fn(async () => [[1, 2, 3, 4]]);
    const inference = new NativeCanonicalInference({
      hostedEmbeddings,
      resolver: resolver(hosted),
      scope,
      transport: { documentEmbeddings: vi.fn() },
    });
    const result = await inference.generate({
      chunks: [{ chunkId: 'chunk', content: 'text' }],
      profile: resolveNativeCanonicalProfile(hosted).profile,
      requestId: 'hosted',
    });
    expect(result.vectors).toEqual([{ chunkId: 'chunk', vector: [1, 2, 3, 4] }]);
    expect(hostedEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'saved-model', provider: 'openai', purpose: 'document' })
    );
    await inference.close();
  });
});
