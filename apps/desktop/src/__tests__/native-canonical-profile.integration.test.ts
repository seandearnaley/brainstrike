// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectModelCatalog } from '@brainstrike/assistant-contract';
import type {
  CanonicalOperationContext,
  CanonicalSourceScope,
} from '@brainstrike/canonical-ingestion';
import type { SelectedEmbeddingRequestPlan } from '@brainstrike/embeddings/inference-plan';
import { type CollectionRecord, StateStore } from '@brainstrike/state-store';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NativeCanonicalProfileResolver } from '../native-canonical-profile';

let store: StateStore;
let directory: string;
const context = (): CanonicalOperationContext => ({
  requestId: 'profile',
  signal: new AbortController().signal,
});
const scope = (id: string): CanonicalSourceScope => ({ embeddingSetId: id, kind: 'collection' });
const localSelection: SelectedEmbeddingRequestPlan = {
  device: 'wasm',
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/bge-small-en-v1.5',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
};

const GRANITE_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GRANITE_REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-profile-catalog-'));
  store = await StateStore.open(directory);
  const records: CollectionRecord[] = [
    {
      createdAt: '2026-10-13T00:00:00.000Z',
      dimensions: 384,
      distance: 'cosine',
      id: 'local',
      modelId: localSelection.modelId,
      modelKey: 'local::Xenova/bge-small-en-v1.5',
      name: 'A renamed collection',
    },
    {
      createdAt: '2026-10-13T00:00:00.000Z',
      dimensions: 1536,
      distance: 'ip',
      id: 'hosted',
      modelId: 'text-embedding-3-large',
      modelKey: 'openai::text-embedding-3-large',
      name: 'Local MiniLM (384D)',
    },
    {
      createdAt: '2026-10-13T00:00:00.000Z',
      dimensions: 384,
      distance: 'cosine',
      id: 'granite',
      modelId: GRANITE_ID,
      modelKey: `local::${GRANITE_ID}`,
      name: 'Workspace Index (Granite)',
    },
    {
      createdAt: '2026-10-13T00:00:00.000Z',
      dimensions: 768,
      distance: 'cosine',
      id: 'unsupported',
      modelId: localSelection.modelId,
      modelKey: 'local::Xenova/bge-small-en-v1.5',
    },
  ];
  for (const collection of records) {
    await store.collections({ collection, operation: 'create' });
  }
  await store.close();
  store = await StateStore.open(directory);
});
afterAll(async () => {
  await store?.close();
  await rm(directory, { force: true, recursive: true });
});

function resolver() {
  const readLocalSelection = vi.fn(
    async (): Promise<SelectedEmbeddingRequestPlan> => localSelection
  );
  const instance = new NativeCanonicalProfileResolver({
    collections: store,
    modelCatalog: { read: async () => projectModelCatalog({ models: [], providers: [] }) },
    readLocalSelection,
    resolveEmbeddingSetId: async (requested) => {
      if (requested.kind === 'workspace' && requested.rootId === 'mounted-root') {
        return 'local';
      }
      if (
        requested.kind === 'collection' &&
        ['local', 'hosted', 'granite', 'unsupported'].includes(requested.embeddingSetId)
      ) {
        return requested.embeddingSetId;
      }
      throw new Error('Scope is not authorized.');
    },
  });
  return { instance, readLocalSelection };
}

it('resolves reopened SQLite collection/provider metadata without repairing or writing saved choices', async () => {
  const before = await store.collections({ operation: 'list' });
  const f = resolver();
  const hosted = await f.instance.resolve(scope('hosted'), context());
  expect(hosted).toEqual({
    modelKey: 'openai::text-embedding-3-large',
    profile: {
      dimensions: 1536,
      distance: 'ip',
      modelId: 'text-embedding-3-large',
      provider: 'openai',
    },
    workerPlan: null,
  });
  expect(f.readLocalSelection).not.toHaveBeenCalled();
  expect((await f.instance.resolve(scope('local'), context())).profile).toMatchObject({
    dimensions: 384,
    distance: 'cosine',
    dtype: 'q8',
    modelId: localSelection.modelId,
    provider: 'local',
    revision: localSelection.revision,
  });
  expect(await store.collections({ operation: 'list' })).toEqual(before);
});

it('uses injected mounted-root authority and rejects unauthorized scopes before catalog reads', async () => {
  const f = resolver();
  expect(
    await f.instance.resolveProfile(
      { scope: { kind: 'workspace', rootId: 'mounted-root' } },
      context()
    )
  ).toEqual((await f.instance.resolve(scope('local'), context())).profile);
  await expect(
    f.instance.resolve({ kind: 'workspace', rootId: 'unknown' }, context())
  ).rejects.toThrow(/authorized/);
});

it('preserves unsupported local dimensions and rejects stale pins without a default or catalog mutation', async () => {
  const f = resolver();
  await expect(f.instance.resolve(scope('unsupported'), context())).rejects.toThrow(/selection/);
  expect(
    (await store.collections({ id: 'unsupported', operation: 'get' })).collections[0]?.dimensions
  ).toBe(768);
  f.readLocalSelection.mockResolvedValueOnce({ ...localSelection, revision: undefined });
  const unpinned = await f.instance.resolve(scope('local'), context());
  expect(unpinned.workerPlan?.revision).toBeUndefined();
  expect(unpinned.profile).not.toHaveProperty('tokenCap');
});

it('resolves the granite catalog pooling and pin through the production model catalog and reopened SQLite collection (BST-1993)', async () => {
  const f = resolver();
  const chosen = {
    device: 'webgpu' as const,
    dimensions: 384,
    dtype: 'fp16',
    modelId: GRANITE_ID,
    revision: GRANITE_REVISION,
  };
  f.readLocalSelection.mockResolvedValue(chosen);
  const resolved = await f.instance.resolve(scope('granite'), context());
  expect(resolved.workerPlan).toEqual({
    ...chosen,
    pooling: 'cls',
    prompts: { document: '', query: '' },
  });
  expect(resolved.profile).toMatchObject({ pooling: 'cls', revision: GRANITE_REVISION });
  f.readLocalSelection.mockResolvedValue(localSelection);
  expect((await f.instance.resolve(scope('local'), context())).workerPlan).not.toHaveProperty(
    'pooling'
  );
});
