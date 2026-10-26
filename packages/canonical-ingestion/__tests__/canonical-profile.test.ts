// @vitest-environment node
import type { CollectionRecord } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import {
  NativeCanonicalInference,
  NativeCanonicalProfileResolver,
  resolveNativeCanonicalProfile,
} from '../src/canonical-profile.js';
import type { CanonicalSourceScope } from '../src/ports.js';

const hosted = {
  dimensions: 1536,
  distance: 'cosine',
  id: 'collection',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
} as const;
const scope: CanonicalSourceScope = { kind: 'workspace', rootId: 'root' };
const row = (saved: typeof hosted): CollectionRecord => ({
  ...saved,
  createdAt: '2026-10-16T00:00:00.000Z',
});
function resolver(saved: typeof hosted) {
  return new NativeCanonicalProfileResolver({
    collections: { collections: async () => ({ collections: [row(saved)] }) },
    resolveEmbeddingSetId: async () => saved.id,
  });
}

describe('canonical profile host seams', () => {
  it('embeds a hosted profile through the hosted embeddings the host gives', async () => {
    const vector = Array.from({ length: hosted.dimensions }, (_, index) => index + 1);
    const hostedEmbeddings = vi.fn(async () => [vector]);
    const inference = new NativeCanonicalInference({
      hostedEmbeddings,
      resolver: resolver(hosted),
      scope,
    });
    const result = await inference.generate({
      chunks: [{ chunkId: 'chunk', content: 'text' }],
      profile: resolveNativeCanonicalProfile(hosted).profile,
      requestId: 'hosted',
    });
    expect(result.vectors).toEqual([{ chunkId: 'chunk', vector }]);
    expect(hostedEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
        purpose: 'document',
        texts: ['text'],
      })
    );
    await inference.close();
  });
});
