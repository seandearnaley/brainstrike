// @vitest-environment node
import type {
  CanonicalOperationContext,
  CanonicalSourceScope,
} from '@brainstrike/canonical-ingestion';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { SelectedEmbeddingRequestPlan } from '@brainstrike/embeddings/inference-plan';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NativeCanonicalProfileResolver } from '../native-canonical-profile';

let database: Awaited<ReturnType<typeof createEnginePglite>>;
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
  database = await createEnginePglite();
  // Actual collection metadata and catalog columns; no jobs or preferences are on this read path.
  await database.exec(`CREATE TABLE embedding_sets (
    id TEXT PRIMARY KEY, model_key TEXT NOT NULL, model_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL, distance TEXT NOT NULL CHECK (distance IN ('cosine','l2','ip')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, name TEXT
  );
  CREATE TABLE models (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL,
    capabilities JSONB, parameters JSONB
  );`);
  await database.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name)
    VALUES ($1,$2,$3,$4,$5,$6), ($7,$8,$9,$10,$11,$12), ($13,$14,$15,$16,$17,$18)`,
    [
      'local',
      'local::Xenova/bge-small-en-v1.5',
      localSelection.modelId,
      384,
      'cosine',
      'A renamed collection',
      'hosted',
      'openai::text-embedding-3-large',
      'text-embedding-3-large',
      1536,
      'ip',
      'Local MiniLM (384D)',
      'granite',
      `local::${GRANITE_ID}`,
      GRANITE_ID,
      384,
      'cosine',
      'Workspace Index (Granite)',
    ]
  );
  // The catalog rows as migrations 015 and 149 write them.
  await database.query(
    `INSERT INTO models (id, provider_id, name, capabilities, parameters)
    VALUES ($1,'local','BGE Small',$2,$3), ($4,'local','Granite Embedding Small R2',$5,$6)`,
    [
      localSelection.modelId,
      { defaultDimension: 384, type: 'embedding' },
      { size: '~34MB' },
      GRANITE_ID,
      { defaultDimension: 384, pooling: 'cls', type: 'embedding' },
      { execution: { wasm: 'q8', webgpu: 'fp16' }, revision: GRANITE_REVISION },
    ]
  );
});
afterAll(async () => {
  await database?.close();
});

function resolver() {
  const readLocalSelection = vi.fn(
    async (): Promise<SelectedEmbeddingRequestPlan> => localSelection
  );
  const instance = new NativeCanonicalProfileResolver({
    query: async (sql, params) => database.query(sql, params),
    readLocalSelection,
    resolveEmbeddingSetId: async (requested) => {
      if (requested.kind === 'workspace' && requested.rootId === 'mounted-root') {
        return 'local';
      }
      if (
        requested.kind === 'collection' &&
        ['local', 'hosted', 'granite'].includes(requested.embeddingSetId)
      ) {
        return requested.embeddingSetId;
      }
      throw new Error('Scope is not authorized.');
    },
  });
  return { instance, readLocalSelection };
}

it('resolves actual PG collection/provider metadata without repairing or writing saved choices', async () => {
  const before = await database.query('SELECT * FROM embedding_sets ORDER BY id');
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
  expect((await database.query('SELECT * FROM embedding_sets ORDER BY id')).rows).toEqual(
    before.rows
  );
});

it('uses injected mounted-root authority and rejects unauthorized scopes before SQL', async () => {
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
  await database.query('UPDATE embedding_sets SET dimensions = $1 WHERE id = $2', [768, 'local']);
  try {
    await expect(f.instance.resolve(scope('local'), context())).rejects.toThrow(/selection/);
    expect(
      (await database.query('SELECT dimensions FROM embedding_sets WHERE id = $1', ['local'])).rows
    ).toEqual([{ dimensions: 768 }]);
  } finally {
    await database.query('UPDATE embedding_sets SET dimensions = $1 WHERE id = $2', [384, 'local']);
  }
  f.readLocalSelection.mockResolvedValueOnce({ ...localSelection, revision: undefined });
  const unpinned = await f.instance.resolve(scope('local'), context());
  expect(unpinned.workerPlan?.revision).toBeUndefined();
  expect(unpinned.profile).not.toHaveProperty('tokenCap');
});

it('resolves the granite catalog pooling and pin through the real catalog join (BST-1993)', async () => {
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
  expect(resolved.workerPlan).toEqual({ ...chosen, pooling: 'cls' });
  expect(resolved.profile).toMatchObject({ pooling: 'cls', revision: GRANITE_REVISION });
  f.readLocalSelection.mockResolvedValue(localSelection);
  expect((await f.instance.resolve(scope('local'), context())).workerPlan).not.toHaveProperty(
    'pooling'
  );
});
