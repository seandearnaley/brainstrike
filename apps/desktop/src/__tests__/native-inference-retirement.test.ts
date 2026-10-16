import { projectModelCatalog } from '@brainstrike/assistant-contract';
// @vitest-environment node
import { providerEnvKeys } from '@brainstrike/assistant-contract/provider-metadata';
import {
  NativeCanonicalInference,
  NativeCanonicalProfileResolver,
} from '@brainstrike/canonical-ingestion';
import { clearHostedProviderApiKeyCache } from '@brainstrike/embeddings/provider-core';
import { afterEach, expect, it, vi } from 'vitest';
import { generateHostedEmbeddings, HostedEmbeddingError } from '../hosted-embeddings';

vi.mock('../secrets', () => ({ getSecretsService: () => ({ getKey: async () => undefined }) }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearHostedProviderApiKeyCache();
});

it('retires an already physically settled missing-key request after generate delivers its failure', async () => {
  for (const key of providerEnvKeys('cohere')) {
    vi.stubEnv(key, '');
    vi.stubEnv(`VITE_${key}`, '');
  }
  clearHostedProviderApiKeyCache();
  const fetch = vi.fn(() => {
    throw new Error('No provider call is authorized in this proof.');
  });
  vi.stubGlobal('fetch', fetch);
  // Provider/model/dimensions from the actual 07e1 missing-key Settings selection.
  const metadata = {
    dimensions: 1024,
    distance: 'cosine',
    id: '240a7a5e-e539-4f14-9d3f-91bfdc9e2be1',
    modelId: 'embed-english-v3.0',
    modelKey: 'cohere::embed-english-v3.0',
  } as const;
  const scope = { embeddingSetId: metadata.id, kind: 'collection' } as const;
  const resolver = new NativeCanonicalProfileResolver({
    collections: {
      collections: async () => ({
        collections: [{ ...metadata, createdAt: '2026-10-13T00:00:00.000Z' }],
      }),
    },
    modelCatalog: { read: async () => projectModelCatalog({ models: [], providers: [] }) },
    readLocalSelection: async () => undefined,
    resolveEmbeddingSetId: async () => metadata.id,
  });
  const documentEmbeddings = vi.fn(async () => []);
  // Desktop's composition hands the shared inference its own hosted embeddings.
  const inference = new NativeCanonicalInference({
    hostedEmbeddings: generateHostedEmbeddings,
    resolver,
    scope,
    transport: { documentEmbeddings },
  });
  const resolved = await resolver.resolve(scope, {
    requestId: 'profile',
    signal: new AbortController().signal,
  });
  const generated = inference.generate({
    chunks: [{ chunkId: 'first', content: ' first content ' }],
    profile: resolved.profile,
    requestId: 'request',
  });
  const failure = await generated.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HostedEmbeddingError);
  expect(failure).toMatchObject({ kind: 'missing-key' });
  expect(fetch).not.toHaveBeenCalled();
  expect(documentEmbeddings).not.toHaveBeenCalled();
  // generate delivered the failure; join only proves the request physically settled.
  await expect(inference.join('request')).resolves.toBeUndefined();
  await expect(inference.close()).resolves.toBeUndefined();
});
