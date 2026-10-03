// @vitest-environment node
import { createHash } from 'node:crypto';
import type {
  CanonicalFileIdentity,
  CanonicalOperationContext,
} from '@brainstrike/canonical-ingestion';
import { FileRecordRepository, JobQueue, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNativeCanonicalCatalog } from '../native-canonical-catalog';

let db: PGlite;
const workspace = { kind: 'workspace', rootId: 'real-root' } as const;
const collection = { embeddingSetId: 'real-set', kind: 'collection' } as const;
const original = 'export const preserved = "original retained source";\n';
function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
const context: CanonicalOperationContext = {
  requestId: 'integration-scan',
  signal: new AbortController().signal,
};
const retained: CanonicalFileIdentity = {
  embeddingSetId: 'real-set',
  fileId: 'retained-file',
  fileName: 'retained.ts',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const managed: CanonicalFileIdentity = {
  embeddingSetId: 'real-set',
  fileId: 'managed-file',
  fileName: 'managed.ts',
  relativePath: 'src/managed.ts',
  rootId: 'real-root',
  sourcePath: '/granted/src/managed.ts',
};
function adapter() {
  const joinNativeRemoval = vi.fn(async () => undefined);
  const replaceTrustedBindings = vi.fn(async () => undefined);
  const catalog = createNativeCanonicalCatalog({
    database: db,
    joinNativeRemoval,
    replaceTrustedBindings,
    resolveProfile: async () => ({
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'actual-model',
      modelKey: 'openai::actual-model',
    }),
    resolveScope: async () => ({
      assertCurrent: () => undefined,
      assertDiscoveredSource: (file) => {
        if (file.rootId !== 'real-root' || file.sourcePath !== `/granted/${file.relativePath}`) {
          throw new Error('foreign discovered source');
        }
      },
      embeddingSetId: 'real-set',
      resolveIdentity: (record) => ({
        embeddingSetId: record.embeddingSetId,
        fileId: record.fileId,
        fileName: record.fileName,
        relativePath: record.rootId === null ? null : record.path,
        rootId: record.rootId,
        sourcePath: record.rootId === null ? null : `/granted/${record.path}`,
      }),
    }),
  });
  return { catalog, joinNativeRemoval, replaceTrustedBindings };
}
async function seed(file: CanonicalFileIdentity): Promise<void> {
  await db.query(
    `INSERT INTO file_records (id, name, path, root_id, embedding_set_id, content, content_hash, size, mtime_ms, token_count, chunks_count, chunks_processed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,42,1,3,CURRENT_TIMESTAMP)`,
    [
      file.fileId,
      file.fileName,
      file.relativePath ?? 'actual-retained-import-path',
      file.rootId,
      file.embeddingSetId,
      original,
      hash(original),
      Buffer.byteLength(original),
    ]
  );
}
beforeAll(async () => {
  db = await wasmLoader.createPGlite('memory://native-canonical-catalog');
  await migrate(db);
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path, status) VALUES ('real-root', 'path', 'Granted root', '/granted', 'live')`
  );
  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance) VALUES ('real-set', 'openai::actual-model', 'actual-model', 1536, 'cosine')`
  );
});
afterAll(async () => {
  await db.close();
});

describe('authoritative catalog with real PGlite and canonical repositories', () => {
  it('preserves rootless catalog, source and saved collection choices through completion', async () => {
    await seed(retained);
    const { catalog } = adapter();
    expect(await catalog.readRetainedSource(retained, 1024, collection, context)).toEqual({
      content: original,
      stat: { mtimeMs: 42, size: Buffer.byteLength(original) },
    });
    expect(
      await catalog.loadAuthorizedBatch({ files: [retained], scope: collection }, context)
    ).toEqual([
      {
        ...retained,
        chunksProcessed: true,
        contentHash: hash(original),
        stat: { mtimeMs: 42, size: Buffer.byteLength(original) },
      },
    ]);
    await catalog.applyManagedCacheBatch(
      {
        files: [
          {
            ...retained,
            content: original,
            contentHash: hash(original),
            stat: { mtimeMs: null, size: Buffer.byteLength(original) },
          },
        ],
        scope: collection,
      },
      context
    );
    await catalog.completeFiles(
      {
        files: [{ chunkCount: 9, contentHash: hash(original), fileId: retained.fileId }],
        scope: collection,
      },
      context
    );
    const file = await new FileRecordRepository(db).findById(retained.fileId);
    expect(file).toMatchObject({
      chunksCount: 9,
      content: original,
      embeddingSetId: 'real-set',
      id: retained.fileId,
      path: 'actual-retained-import-path',
    });
    const model = await db.query(
      'SELECT model_key, model_id, dimensions, distance FROM embedding_sets WHERE id = $1',
      ['real-set']
    );
    expect(model.rows).toEqual([
      {
        dimensions: 1536,
        distance: 'cosine',
        model_id: 'actual-model',
        model_key: 'openai::actual-model',
      },
    ]);
  });
  it('uses managed-cache replacement policy, invalidates completion and floors actual native mtime', async () => {
    await seed(managed);
    const { catalog, replaceTrustedBindings } = adapter();
    const next = `${original}// changed original source\n`;
    await catalog.applyManagedCacheBatch(
      {
        files: [
          {
            ...managed,
            content: next,
            contentHash: hash(next),
            stat: { mtimeMs: 123.75, size: Buffer.byteLength(next) },
          },
        ],
        scope: workspace,
      },
      context
    );
    expect(replaceTrustedBindings).toHaveBeenCalledOnce();
    const repository = new FileRecordRepository(db);
    expect(
      await repository.findByManagedCacheIdentity('real-set', 'real-root', 'src/managed.ts')
    ).toMatchObject({
      chunksCount: 0,
      content: next,
      contentHash: hash(next),
      id: managed.fileId,
      tokenCount: Math.ceil(next.length / 4),
    });
    expect(
      await catalog.loadAuthorizedBatch({ files: [managed], scope: workspace }, context)
    ).toEqual([
      {
        ...managed,
        chunksProcessed: false,
        contentHash: hash(next),
        stat: { mtimeMs: 123, size: Buffer.byteLength(next) },
      },
    ]);
    await expect(
      catalog.completeFiles(
        {
          files: [{ chunkCount: 999, contentHash: hash(original), fileId: managed.fileId }],
          scope: workspace,
        },
        context
      )
    ).rejects.toThrow('hash');
    expect(await repository.findById(managed.fileId)).toMatchObject({
      chunksCount: 0,
      content: next,
    });
  });
  it('deletes exact managed membership only after native removal and cancels legacy jobs through the canonical policy', async () => {
    const file = {
      ...managed,
      fileId: 'removed-file',
      fileName: 'removed.ts',
      relativePath: 'src/removed.ts',
      sourcePath: '/granted/src/removed.ts',
    };
    await seed(file);
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding_set_id) VALUES ('removed-chunk', 'removed-file', 0, 'derived', 'derived-hash', 1, 'sentence', 7, 'real-set')`
    );
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, chunk_id, state) VALUES ('removed-job', 'embeddings', 'embed_chunk', '{}'::jsonb, 'removed-chunk', 'queued')`
    );
    const { catalog } = adapter();
    await catalog.removeFiles({ files: [file], scope: workspace }, context);
    const repository = new FileRecordRepository(db);
    expect(await repository.findById(file.fileId)).toBeNull();
    expect(await repository.findById(managed.fileId)).not.toBeNull();
    expect(
      (await db.query('SELECT state FROM job_queue WHERE id = $1', ['removed-job'])).rows
    ).toEqual([{ state: 'canceled' }]);
    expect(
      (await db.query('SELECT id FROM file_chunks WHERE id = $1', ['removed-chunk'])).rows
    ).toEqual([]);
  });
  it('joins native rootless removal, cancels queued and running jobs and revokes the running lease', async () => {
    const file = { ...retained, fileId: 'removed-rootless-file' };
    const untouched = { ...retained, fileId: 'untouched-rootless-file' };
    await seed(file);
    await seed(untouched);
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding_set_id)
       VALUES ('rootless-queued-chunk', $1, 0, 'derived', 'queued-hash', 1, 'sentence', 7, 'real-set'),
              ('rootless-running-chunk', $1, 1, 'derived', 'running-hash', 1, 'sentence', 7, 'real-set'),
              ('rootless-untouched-chunk', $2, 0, 'derived', 'untouched-hash', 1, 'sentence', 7, 'real-set')`,
      [file.fileId, untouched.fileId]
    );
    const queueName = 'catalog-rootless-removal';
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, chunk_id, state, lease_token, leased_until, worker_id)
       VALUES ('rootless-queued-job', $1, 'embed_chunk', '{}'::jsonb, 'rootless-queued-chunk', 'queued', NULL, NULL, NULL),
              ('rootless-running-job', $1, 'embed_chunk', '{}'::jsonb, 'rootless-running-chunk', 'running', 'rootless-lease', $2, 'rootless-worker'),
              ('rootless-untouched-job', $1, 'embed_chunk', '{}'::jsonb, 'rootless-untouched-chunk', 'queued', NULL, NULL, NULL)`,
      [queueName, new Date(Date.now() + 60_000).toISOString()]
    );
    const { catalog, joinNativeRemoval } = adapter();
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const nativeRemoval = new Promise<void>((resolve) => {
      release = resolve;
    });
    joinNativeRemoval.mockImplementation(async () => {
      entered();
      await nativeRemoval;
    });
    const removal = catalog.removeFiles({ files: [file], scope: collection }, context);
    await admitted;
    try {
      expect(await new FileRecordRepository(db).findById(file.fileId)).not.toBeNull();
      expect(
        (
          await db.query('SELECT state, lease_token FROM job_queue WHERE id = $1', [
            'rootless-running-job',
          ])
        ).rows
      ).toEqual([{ lease_token: 'rootless-lease', state: 'running' }]);
    } finally {
      release();
      await removal;
    }
    expect(await new FileRecordRepository(db).findById(file.fileId)).toBeNull();
    expect(await new FileRecordRepository(db).findById(untouched.fileId)).not.toBeNull();
    expect(
      (await db.query('SELECT id FROM file_chunks WHERE file_record_id = $1', [file.fileId])).rows
    ).toEqual([]);
    expect(
      (
        await db.query(
          'SELECT id, state, lease_token, leased_until, worker_id FROM job_queue WHERE queue = $1 ORDER BY id',
          [queueName]
        )
      ).rows
    ).toEqual([
      {
        id: 'rootless-queued-job',
        lease_token: null,
        leased_until: null,
        state: 'canceled',
        worker_id: null,
      },
      {
        id: 'rootless-running-job',
        lease_token: null,
        leased_until: null,
        state: 'canceled',
        worker_id: null,
      },
      {
        id: 'rootless-untouched-job',
        lease_token: null,
        leased_until: null,
        state: 'queued',
        worker_id: null,
      },
    ]);
    expect(
      (
        await db.query(
          'SELECT canceled_total::text AS count FROM job_queue_metrics WHERE queue = $1',
          [queueName]
        )
      ).rows
    ).toEqual([{ count: '2' }]);
    const queue = new JobQueue(db);
    const lease = { id: 'rootless-running-job', leaseToken: 'rootless-lease' };
    expect(await queue.heartbeat({ ...lease, extendMs: 60_000 })).toBeNull();
    expect(await queue.complete(lease)).toBeNull();
    expect(
      (await queue.claimMany({ leaseMs: 60_000, queue: queueName, workerId: 'after-removal' })).map(
        (job) => job.id
      )
    ).toEqual(['rootless-untouched-job']);
  });
  it('reuses PG root/path identity, allocates real new UUIDs and retains real content before binding acknowledgment', async () => {
    const { catalog, replaceTrustedBindings } = adapter();
    const source = {
      content: original,
      contentHash: hash(original),
      fileName: 'discovered.ts',
      relativePath: 'src/discovered.ts',
      rootId: 'real-root',
      sourcePath: '/granted/src/discovered.ts',
      stat: { mtimeMs: 246.9, size: Buffer.byteLength(original) },
    };
    let acknowledge!: () => void;
    let admitted!: () => void;
    const gate = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    replaceTrustedBindings.mockImplementationOnce(async () => {
      admitted();
      await gate;
    });
    const operation = catalog.prepareManagedSourcesBatch(
      { files: [source], scope: workspace },
      context
    );
    await entered;
    const repository = new FileRecordRepository(db);
    const committed = await repository.findByManagedCacheIdentity(
      'real-set',
      'real-root',
      source.relativePath
    );
    expect(committed).toMatchObject({
      content: original,
      contentHash: hash(original),
      name: source.fileName,
      tokenCount: Math.ceil(original.length / 4),
    });
    expect(committed?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    acknowledge();
    const prepared = await result;
    expect(prepared).toEqual([
      {
        contentHash: hash(original),
        embeddingSetId: 'real-set',
        fileId: committed?.id,
        fileName: source.fileName,
        relativePath: source.relativePath,
        rootId: source.rootId,
        sourcePath: source.sourcePath,
      },
    ]);
    const changed = `${original}// real replacement
`;
    const repeated = await catalog.prepareManagedSourcesBatch(
      {
        files: [
          {
            ...source,
            content: changed,
            contentHash: hash(changed),
            stat: { mtimeMs: 999.1, size: Buffer.byteLength(changed) },
          },
        ],
        scope: workspace,
      },
      context
    );
    expect(repeated[0]?.fileId).toBe(prepared[0]?.fileId);
    expect(
      await repository.findByManagedCacheIdentity('real-set', 'real-root', source.relativePath)
    ).toMatchObject({ content: changed, id: prepared[0]?.fileId });
    expect(
      (
        await db.query('SELECT id FROM file_records WHERE root_id = $1 AND path = $2', [
          'real-root',
          source.relativePath,
        ])
      ).rows
    ).toHaveLength(1);
  });
  it('joins admitted preparation ACK on cancellation and suppresses returned identities while preserving committed source', async () => {
    const { catalog, replaceTrustedBindings } = adapter();
    const source = {
      content: original,
      contentHash: hash(original),
      fileName: 'cancelled.ts',
      relativePath: 'src/cancelled.ts',
      rootId: 'real-root',
      sourcePath: '/granted/src/cancelled.ts',
      stat: { mtimeMs: 42, size: Buffer.byteLength(original) },
    };
    const controller = new AbortController();
    let acknowledge!: () => void;
    let admitted!: () => void;
    const gate = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    replaceTrustedBindings.mockImplementationOnce(async () => {
      admitted();
      await gate;
    });
    const operation = catalog.prepareManagedSourcesBatch(
      { files: [source], scope: workspace },
      { ...context, signal: controller.signal }
    );
    await entered;
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    controller.abort(new Error('cancelled discovery'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    acknowledge();
    await expect(result).rejects.toThrow('cancelled discovery');
    expect(
      await new FileRecordRepository(db).findByManagedCacheIdentity(
        'real-set',
        'real-root',
        source.relativePath
      )
    ).toMatchObject({ content: original, contentHash: hash(original) });
  });
  it('refuses stale prepared source changed while full binding replacement is admitted', async () => {
    const { catalog, replaceTrustedBindings } = adapter();
    const source = {
      content: original,
      contentHash: hash(original),
      fileName: 'stale.ts',
      relativePath: 'src/stale.ts',
      rootId: 'real-root',
      sourcePath: '/granted/src/stale.ts',
      stat: { mtimeMs: 42, size: Buffer.byteLength(original) },
    };
    replaceTrustedBindings.mockImplementationOnce(async () => {
      await db.query('UPDATE file_records SET content_hash = $1 WHERE root_id = $2 AND path = $3', [
        'newer-source-hash',
        'real-root',
        source.relativePath,
      ]);
    });
    await expect(
      catalog.prepareManagedSourcesBatch({ files: [source], scope: workspace }, context)
    ).rejects.toThrow('stale after binding');
  });
  it('rejects an absent live PG root without allocating a placeholder identity', async () => {
    const { catalog } = adapter();
    const source = {
      content: original,
      contentHash: hash(original),
      fileName: 'revoked.ts',
      relativePath: 'src/revoked.ts',
      rootId: 'real-root',
      sourcePath: '/granted/src/revoked.ts',
      stat: { mtimeMs: 42, size: Buffer.byteLength(original) },
    };
    await db.query('UPDATE roots SET status = $1 WHERE id = $2', ['needs-regrant', 'real-root']);
    try {
      await expect(
        catalog.prepareManagedSourcesBatch({ files: [source], scope: workspace }, context)
      ).rejects.toThrow('absent or revoked');
      expect(
        (await db.query('SELECT id FROM file_records WHERE path = $1', [source.relativePath])).rows
      ).toEqual([]);
    } finally {
      await db.query('UPDATE roots SET status = $1 WHERE id = $2', ['live', 'real-root']);
    }
  });
  it('bounds retained original text in PG and stamps a real missing source hash without changing identity', async () => {
    const file = { ...retained, fileId: 'retained-unhashed', fileName: 'unhashed.ts' };
    await seed(file);
    await db.query('UPDATE file_records SET content_hash = NULL WHERE id = $1', [file.fileId]);
    const { catalog } = adapter();
    await expect(catalog.readRetainedSource(file, 1, collection, context)).rejects.toThrow('bound');
    const read = await catalog.readRetainedSource(file, 1024, collection, context);
    expect(read.content).toBe(original);
    await catalog.applyManagedCacheBatch(
      { files: [{ ...file, ...read, contentHash: hash(read.content) }], scope: collection },
      context
    );
    await catalog.completeFiles(
      {
        files: [{ chunkCount: 1, contentHash: hash(original), fileId: file.fileId }],
        scope: collection,
      },
      context
    );
    expect(await new FileRecordRepository(db).findById(file.fileId)).toMatchObject({
      chunksCount: 1,
      content: original,
      contentHash: hash(original),
      id: file.fileId,
      path: 'actual-retained-import-path',
    });
  });
  it('rolls back already admitted completion when the scope becomes stale before transaction completion', async () => {
    let current = true;
    const catalog = createNativeCanonicalCatalog({
      database: {
        query: db.query.bind(db),
        transaction: async (run) =>
          await db.transaction(
            async (tx) =>
              await run({
                query: async <T = unknown>(
                  sql: string,
                  params?: unknown[]
                ): Promise<{ rows: T[] }> => {
                  const result = await tx.query<T>(sql, params);
                  if (sql.startsWith('UPDATE')) {
                    current = false;
                  }
                  return result;
                },
              })
          ),
      },
      joinNativeRemoval: async () => undefined,
      replaceTrustedBindings: async () => undefined,
      resolveProfile: async () => null,
      resolveScope: async () => ({
        assertCurrent: () => {
          if (!current) {
            throw new Error('stale generation');
          }
        },
        assertDiscoveredSource: () => undefined,
        embeddingSetId: 'real-set',
        resolveIdentity: () => retained,
      }),
    });
    await expect(
      catalog.completeFiles(
        {
          files: [{ chunkCount: 999, contentHash: hash(original), fileId: retained.fileId }],
          scope: collection,
        },
        context
      )
    ).rejects.toThrow('stale generation');
    expect(await new FileRecordRepository(db).findById(retained.fileId)).toMatchObject({
      chunksCount: 9,
      content: original,
    });
  });
});
