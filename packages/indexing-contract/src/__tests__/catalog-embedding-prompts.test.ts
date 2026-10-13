import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeCatalogEmbeddingFacts,
  decodeCatalogEmbeddingModel,
  decodeEmbeddingPrompts,
} from '../catalog-embedding-model.js';
import { type IndexerEmbeddingProfile, indexerEmbeddingProfileValues } from '../indexer-client.js';

const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';
const row = (prompts: unknown) => ({
  capabilities: { defaultDimension: 384, prompts, type: 'embedding' },
  id: 'Xenova/bge-small-en-v1.5',
  parameters: { size: '~34MB' },
});
const local: IndexerEmbeddingProfile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/bge-small-en-v1.5',
  provider: 'local',
};
// The native vectorProfileHash of this profile stating no prompts, pinned like packages/indexer's.
const STATED_NONE_HASH = '4afaa10ee969bc0a91637d52f77b7c4aaad0e56f3b97c4b09dbab50901baa046';
const hash = (profile: IndexerEmbeddingProfile): string =>
  createHash('sha256')
    .update(JSON.stringify(indexerEmbeddingProfileValues(profile)))
    .digest('hex');

describe('catalog embedding prompts (BST-1993)', () => {
  it('takes exactly the prompts a row states, none included, and refuses a row stating nothing', () => {
    expect(decodeCatalogEmbeddingModel(row({ document: '', query: BGE_QUERY })).prompts).toEqual({
      document: '',
      query: BGE_QUERY,
    });
    expect(decodeCatalogEmbeddingModel(row({ document: '', query: '' })).prompts).toEqual({
      document: '',
      query: '',
    });
    expect(() => decodeCatalogEmbeddingModel(row(undefined))).toThrow('states no prompts');
  });

  it('gives the service no prompt text for a row stating none', () => {
    expect(decodeEmbeddingPrompts({ document: '', query: '' }, 'model')).toBeUndefined();
    expect(
      decodeCatalogEmbeddingFacts({ prompts: { document: '', query: BGE_QUERY } }, 'model')
    ).toEqual({ prompts: { document: '', query: BGE_QUERY } });
  });

  it.each([
    'Represent: ',
    { query: BGE_QUERY },
    { document: 7, query: '' },
    { document: '', extra: '', query: '' },
  ])('refuses malformed prompts %j instead of guessing', (prompts) => {
    expect(() => decodeCatalogEmbeddingModel(row(prompts))).toThrow('prompts');
  });

  it('separates stated prompts, stated none and the guessed-prompt era in the identity', () => {
    const none = hash({ ...local, prompts: { document: '', query: '' } });
    expect(none).toBe(STATED_NONE_HASH);
    expect(hash({ ...local, prompts: { document: '', query: BGE_QUERY } })).not.toBe(none);
    expect(hash(local)).not.toBe(none);
  });
});
