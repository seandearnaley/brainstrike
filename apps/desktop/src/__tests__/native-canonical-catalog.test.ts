// @vitest-environment node
import { createHash } from 'node:crypto';
import type {
  CanonicalFileIdentity,
  CanonicalOperationContext,
} from '@brainstrike/canonical-ingestion';
import type { IDatabase } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeCanonicalCatalog,
  type NativeCanonicalCatalogDependencies,
  type NativeCanonicalCatalogRecord,
} from '../native-canonical-catalog';

const workspace = { kind: 'workspace', rootId: 'root' } as const;
const collection = { embeddingSetId: 'set', kind: 'collection' } as const;
const content = 'export const original = true;\n';
const hash = createHash('sha256').update(content).digest('hex');
const file: CanonicalFileIdentity = {
  embeddingSetId: 'set',
  fileId: 'file',
  fileName: 'a.ts',
  relativePath: 'src/a.ts',
  rootId: 'root',
  sourcePath: '/granted/src/a.ts',
};
const record: NativeCanonicalCatalogRecord = {
  chunksProcessed: false,
  content,
  contentHash: hash,
  embeddingSetId: 'set',
  fileId: 'file',
  fileName: 'a.ts',
  path: 'src/a.ts',
  rootId: 'root',
  stat: { mtimeMs: 42, size: Buffer.byteLength(content) },
};
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(row: NativeCanonicalCatalogRecord = record) {
  const controller = new AbortController();
  const context: CanonicalOperationContext = { requestId: 'scan', signal: controller.signal };
  let current = true;
  const query = vi.fn(
    async (sql: string): Promise<{ rows: unknown[] }> => ({
      rows: sql.startsWith('SELECT') ? [row] : [{ fileId: row.fileId }],
    })
  );
  const database: IDatabase = {
    query: async <T = unknown>(sql: string): Promise<{ rows: T[] }> => {
      const result = await query(sql);
      return result as { rows: T[] };
    },
  };
  const transaction = vi.fn(() => undefined);
  const dependencies: NativeCanonicalCatalogDependencies<string> = {
    database: {
      ...database,
      transaction: async <T>(run: (tx: IDatabase) => Promise<T>): Promise<T> => {
        transaction();
        return await run(database);
      },
    },
    joinNativeRemoval: vi.fn(async () => undefined),
    replaceTrustedBindings: vi.fn(async () => undefined),
    resolveProfile: vi.fn(async () => 'actual-profile'),
    resolveScope: vi.fn(async () => ({
      assertCurrent: () => {
        if (!current) {
          throw new Error('stale scope');
        }
      },
      assertDiscoveredSource: () => undefined,
      embeddingSetId: 'set',
      resolveIdentity: (loaded: NativeCanonicalCatalogRecord) => ({
        ...file,
        embeddingSetId: loaded.embeddingSetId,
        fileId: loaded.fileId,
        fileName: loaded.fileName,
        relativePath: loaded.rootId === null ? null : loaded.path,
        rootId: loaded.rootId,
        sourcePath: loaded.rootId === null ? null : file.sourcePath,
      }),
    })),
  };
  return {
    catalog: createNativeCanonicalCatalog(dependencies),
    context,
    controller,
    dependencies,
    query,
    revoke: () => {
      current = false;
    },
    transaction,
  };
}

describe('authoritative native canonical catalog', () => {
  it('preserves nullable rootless metadata and reads original retained content', async () => {
    const f = fixture({ ...record, path: 'retained import', rootId: null });
    const rootless = { ...file, relativePath: null, rootId: null, sourcePath: null };
    expect(
      await f.catalog.loadAuthorizedBatch({ files: [rootless], scope: collection }, f.context)
    ).toEqual([{ ...rootless, chunksProcessed: false, contentHash: hash, stat: record.stat }]);
    expect(await f.catalog.readRetainedSource(rootless, 1000, collection, f.context)).toEqual({
      content,
      stat: record.stat,
    });
  });
  it.each<[string, NativeCanonicalCatalogRecord[]]>([
    ['missing', []],
    ['duplicate PG identity', [record, record]],
    ['foreign collection', [{ ...record, embeddingSetId: 'foreign' }]],
    ['foreign root', [{ ...record, rootId: 'foreign' }]],
  ])('refuses %s authority before binding publication', async (_name, rows) => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows });
    await expect(
      f.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, f.context)
    ).rejects.toThrow();
    expect(f.dependencies.replaceTrustedBindings).not.toHaveBeenCalled();
  });
  it('rejects mismatched and duplicate caller identities', async () => {
    const f = fixture();
    await expect(
      f.catalog.loadAuthorizedBatch(
        { files: [{ ...file, sourcePath: '/forged/a.ts' }], scope: workspace },
        f.context
      )
    ).rejects.toThrow('identity');
    await expect(
      f.catalog.loadAuthorizedBatch({ files: [file, file], scope: workspace }, f.context)
    ).rejects.toThrow('duplicate');
  });
  it('joins binding acknowledgement and suppresses return after cancellation', async () => {
    const f = fixture();
    const admitted = deferred<void>();
    const binding = deferred<void>();
    vi.mocked(f.dependencies.replaceTrustedBindings).mockImplementation(async () => {
      admitted.resolve();
      await binding.promise;
    });
    const operation = f.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, f.context);
    await admitted.promise;
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    const rejection = expect(result).rejects.toThrow('cancelled scan');
    f.controller.abort(new Error('cancelled scan'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(settled).toBe(false);
    } finally {
      binding.resolve();
      await rejection;
    }
  });
  it('joins admitted PG work and refuses later binding publication on cancellation', async () => {
    const f = fixture();
    const admitted = deferred<void>();
    const pg = deferred<void>();
    f.query.mockImplementationOnce(async () => {
      admitted.resolve();
      await pg.promise;
      return { rows: [record] };
    });
    const operation = f.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, f.context);
    await admitted.promise;
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    f.controller.abort(new Error('cancelled scan'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    pg.resolve();
    await expect(result).rejects.toThrow('cancelled scan');
    expect(f.dependencies.replaceTrustedBindings).not.toHaveBeenCalled();
  });
  it('guards completion by content hash and current scope, rejects missed SQL guards', async () => {
    const f = fixture();
    const request = {
      files: [{ chunkCount: 2, contentHash: hash, fileId: file.fileId }],
      scope: workspace,
    };
    f.query.mockResolvedValueOnce({ rows: [{ ...record, contentHash: 'newer-source' }] });
    await expect(f.catalog.completeFiles(request, f.context)).rejects.toThrow('hash');
    expect(f.query).toHaveBeenCalledTimes(1);
    f.revoke();
    await expect(f.catalog.completeFiles(request, f.context)).rejects.toThrow('stale scope');
    const g = fixture();
    g.query.mockResolvedValueOnce({ rows: [record] }).mockResolvedValueOnce({ rows: [] });
    await expect(g.catalog.completeFiles(request, g.context)).rejects.toThrow('stale');
  });
  it('joins native removal before catalog invalidation', async () => {
    const f = fixture({ ...record, rootId: null });
    f.query.mockImplementation(async (sql) => ({
      rows: sql.startsWith('SELECT')
        ? [{ ...record, rootId: null }]
        : sql.includes('WITH targets')
          ? [{ chunk_id: null, file_record_id: record.fileId }]
          : [],
    }));
    const rootless = { ...file, relativePath: null, rootId: null, sourcePath: null };
    const entered = deferred<void>();
    const removal = deferred<void>();
    vi.mocked(f.dependencies.joinNativeRemoval).mockImplementation(async () => {
      entered.resolve();
      await removal.promise;
    });
    const operation = f.catalog.removeFiles({ files: [rootless], scope: collection }, f.context);
    await entered.promise;
    expect(f.transaction).not.toHaveBeenCalled();
    removal.resolve();
    await operation;
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(true);
  });
  it('refuses changed retained source and invalid hashes before mutation', async () => {
    const f = fixture({ ...record, rootId: null });
    const rootless = { ...file, relativePath: null, rootId: null, sourcePath: null };
    await expect(
      f.catalog.applyManagedCacheBatch(
        {
          files: [
            {
              ...rootless,
              content: 'changed',
              contentHash: createHash('sha256').update('changed').digest('hex'),
              stat: record.stat,
            },
          ],
          scope: collection,
        },
        f.context
      )
    ).rejects.toThrow('retained');
    await expect(
      f.catalog.applyManagedCacheBatch(
        {
          files: [{ ...file, content, contentHash: 'forged', stat: record.stat }],
          scope: workspace,
        },
        f.context
      )
    ).rejects.toThrow('hash');
  });
  it('does not invalidate PG after cancellation during native removal', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const removal = deferred<void>();
    vi.mocked(f.dependencies.joinNativeRemoval).mockImplementation(async () => {
      entered.resolve();
      await removal.promise;
    });
    const operation = f.catalog.removeFiles({ files: [file], scope: workspace }, f.context);
    await entered.promise;
    f.controller.abort(new Error('cancelled removal'));
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    removal.resolve();
    await expect(result).rejects.toThrow('cancelled removal');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('refuses absent or oversized retained source and malformed PG rows', async () => {
    const rootless = { ...file, relativePath: null, rootId: null, sourcePath: null };
    const f = fixture({ ...record, content: null, rootId: null });
    await expect(f.catalog.readRetainedSource(rootless, 10, collection, f.context)).rejects.toThrow(
      'absent'
    );
    const g = fixture({ ...record, rootId: null });
    await expect(g.catalog.readRetainedSource(rootless, 1, collection, g.context)).rejects.toThrow(
      'bound'
    );
    g.query.mockResolvedValueOnce({ rows: [{ ...record, stat: { mtimeMs: 1, size: -1 } }] });
    await expect(
      g.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, g.context)
    ).rejects.toThrow();
  });
  it('refuses pre-aborted operations and bounded duplicate completion batches before PG mutation', async () => {
    const f = fixture();
    f.controller.abort(new Error('already cancelled'));
    await expect(
      f.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, f.context)
    ).rejects.toThrow('already cancelled');
    expect(f.dependencies.resolveScope).not.toHaveBeenCalled();
    const g = fixture();
    const completion = { chunkCount: 2, contentHash: hash, fileId: file.fileId };
    await expect(
      g.catalog.completeFiles({ files: [completion, completion], scope: workspace }, g.context)
    ).rejects.toThrow('duplicate');
    await expect(
      g.catalog.completeFiles(
        {
          files: Array.from({ length: 251 }, (_, index) => ({
            ...completion,
            fileId: String(index),
          })),
          scope: workspace,
        },
        g.context
      )
    ).rejects.toThrow('250');
    expect(g.transaction).not.toHaveBeenCalled();
  });
  it('preserves an independent binding failure after late cancellation', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.replaceTrustedBindings).mockImplementation(async () => {
      f.controller.abort();
      throw new Error('native transport failed');
    });
    await expect(
      f.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, f.context)
    ).rejects.toThrow('native transport failed');
  });
  it('refreshes registered catalog metadata after binding acknowledgment and rejects revoked membership', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.replaceTrustedBindings).mockImplementationOnce(async () => {
      f.query.mockResolvedValueOnce({ rows: [{ ...record, contentHash: 'newer-source-hash' }] });
    });
    const files = await f.catalog.loadAuthorizedBatch(
      { files: [file], scope: workspace },
      f.context
    );
    expect(files[0]?.contentHash).toBe('newer-source-hash');
    const g = fixture();
    vi.mocked(g.dependencies.replaceTrustedBindings).mockImplementationOnce(async () => {
      g.query.mockResolvedValueOnce({ rows: [{ ...record, embeddingSetId: 'foreign' }] });
    });
    await expect(
      g.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, g.context)
    ).rejects.toThrow('scope');
  });
  it('rejects foreign, duplicate, revoked or hash-mismatched discovery before PG mutation', async () => {
    const source = {
      content,
      contentHash: hash,
      fileName: file.fileName,
      relativePath: 'src/a.ts',
      rootId: 'root',
      sourcePath: '/granted/src/a.ts',
      stat: record.stat,
    };
    const f = fixture();
    await expect(
      f.catalog.prepareManagedSourcesBatch(
        { files: [{ ...source, rootId: 'foreign' }], scope: workspace },
        f.context
      )
    ).rejects.toThrow('foreign');
    await expect(
      f.catalog.prepareManagedSourcesBatch({ files: [source, source], scope: workspace }, f.context)
    ).rejects.toThrow('duplicate');
    await expect(
      f.catalog.prepareManagedSourcesBatch(
        { files: [{ ...source, contentHash: 'forged' }], scope: workspace },
        f.context
      )
    ).rejects.toThrow('hash');
    vi.mocked(f.dependencies.resolveScope).mockResolvedValueOnce({
      assertCurrent: () => undefined,
      assertDiscoveredSource: () => {
        throw new Error('revoked grant');
      },
      embeddingSetId: 'set',
      resolveIdentity: () => file,
    });
    await expect(
      f.catalog.prepareManagedSourcesBatch({ files: [source], scope: workspace }, f.context)
    ).rejects.toThrow('revoked grant');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('resolves the actual profile only under the authorized scope', async () => {
    const f = fixture();
    expect(await f.catalog.resolveProfile({ scope: collection }, f.context)).toBe('actual-profile');
    f.revoke();
    await expect(f.catalog.resolveProfile({ scope: collection }, f.context)).rejects.toThrow(
      'stale scope'
    );
  });
});
