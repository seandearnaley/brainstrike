// @vitest-environment node
import { createHash } from 'node:crypto';
import type {
  CanonicalFileIdentity,
  CanonicalOperationContext,
} from '@brainstrike/canonical-ingestion';
import type { SourceCatalogPort, SourceCatalogRecord } from '@brainstrike/state-store';
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
const record: SourceCatalogRecord = {
  chunksCount: null,
  chunksProcessed: false,
  content,
  contentHash: hash,
  createdAt: '2026-10-13T00:00:00.000Z',
  embeddingSetId: 'set',
  fileId: 'file',
  fileName: 'a.ts',
  path: 'src/a.ts',
  rootId: 'root',
  stat: { mtimeMs: 42, size: Buffer.byteLength(content) },
  updatedAt: '2026-10-13T00:00:00.000Z',
};
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(row: SourceCatalogRecord = record) {
  const controller = new AbortController();
  const context: CanonicalOperationContext = { requestId: 'scan', signal: controller.signal };
  let current = true;
  const sourceCatalog = vi.fn<SourceCatalogPort['sourceCatalog']>(async () => ({
    files: [row],
  }));
  const dependencies: NativeCanonicalCatalogDependencies<string> = {
    catalog: { sourceCatalog },
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
    revoke: () => {
      current = false;
    },
    sourceCatalog,
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
  it.each<[string, SourceCatalogRecord[]]>([
    ['missing', []],
    ['duplicate catalog identity', [record, record]],
    ['foreign collection', [{ ...record, embeddingSetId: 'foreign' }]],
    ['foreign root', [{ ...record, rootId: 'foreign' }]],
  ])('refuses %s authority before binding publication', async (_name, rows) => {
    const f = fixture();
    f.sourceCatalog.mockResolvedValueOnce({ files: rows });
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
  it('joins admitted catalog work and refuses later binding publication on cancellation', async () => {
    const f = fixture();
    const admitted = deferred<void>();
    const read = deferred<void>();
    f.sourceCatalog.mockImplementationOnce(async () => {
      admitted.resolve();
      await read.promise;
      return { files: [record] };
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
    read.resolve();
    await expect(result).rejects.toThrow('cancelled scan');
    expect(f.dependencies.replaceTrustedBindings).not.toHaveBeenCalled();
  });
  it('guards completion by content hash and current scope, rejects writer compare-and-swap refusal', async () => {
    const f = fixture();
    const request = {
      files: [{ chunkCount: 2, contentHash: hash, fileId: file.fileId }],
      scope: workspace,
    };
    f.sourceCatalog.mockResolvedValueOnce({ files: [{ ...record, contentHash: 'newer-source' }] });
    await expect(f.catalog.completeFiles(request, f.context)).rejects.toThrow('hash');
    expect(f.sourceCatalog).toHaveBeenCalledTimes(1);
    f.revoke();
    await expect(f.catalog.completeFiles(request, f.context)).rejects.toThrow('stale scope');
    const g = fixture();
    g.sourceCatalog
      .mockResolvedValueOnce({ files: [record] })
      .mockRejectedValueOnce(new Error('stale source compare-and-swap'));
    await expect(g.catalog.completeFiles(request, g.context)).rejects.toThrow('stale');
  });
  it('joins native removal before catalog invalidation', async () => {
    const f = fixture({ ...record, rootId: null });
    const rootless = { ...file, relativePath: null, rootId: null, sourcePath: null };
    const entered = deferred<void>();
    const removal = deferred<void>();
    vi.mocked(f.dependencies.joinNativeRemoval).mockImplementation(async () => {
      entered.resolve();
      await removal.promise;
    });
    const operation = f.catalog.removeFiles({ files: [rootless], scope: collection }, f.context);
    await entered.promise;
    expect(f.sourceCatalog.mock.calls.some(([request]) => request.operation === 'remove')).toBe(
      false
    );
    removal.resolve();
    await operation;
    expect(
      f.sourceCatalog.mock.calls.filter(([request]) => request.operation === 'remove')
    ).toHaveLength(1);
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
  it('does not invalidate the catalog after cancellation during native removal', async () => {
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
    expect(f.sourceCatalog.mock.calls.some(([request]) => request.operation === 'remove')).toBe(
      false
    );
  });
  it('refuses absent or oversized retained source and malformed catalog records', async () => {
    const rootless = { ...file, relativePath: null, rootId: null, sourcePath: null };
    const f = fixture({ ...record, content: null, rootId: null });
    await expect(f.catalog.readRetainedSource(rootless, 10, collection, f.context)).rejects.toThrow(
      'absent'
    );
    const g = fixture({ ...record, rootId: null });
    await expect(g.catalog.readRetainedSource(rootless, 1, collection, g.context)).rejects.toThrow(
      'bound'
    );
    g.sourceCatalog.mockResolvedValueOnce({
      files: [{ ...record, stat: { mtimeMs: 1, size: -1 } }],
    });
    await expect(
      g.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, g.context)
    ).rejects.toThrow();
  });
  it('refuses pre-aborted operations and bounded duplicate completion batches before catalog mutation', async () => {
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
    expect(g.sourceCatalog).not.toHaveBeenCalled();
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
      f.sourceCatalog.mockResolvedValueOnce({
        files: [{ ...record, contentHash: 'newer-source-hash' }],
      });
    });
    const files = await f.catalog.loadAuthorizedBatch(
      { files: [file], scope: workspace },
      f.context
    );
    expect(files[0]?.contentHash).toBe('newer-source-hash');
    const g = fixture();
    vi.mocked(g.dependencies.replaceTrustedBindings).mockImplementationOnce(async () => {
      g.sourceCatalog.mockResolvedValueOnce({ files: [{ ...record, embeddingSetId: 'foreign' }] });
    });
    await expect(
      g.catalog.loadAuthorizedBatch({ files: [file], scope: workspace }, g.context)
    ).rejects.toThrow('scope');
  });
  it('rejects foreign, duplicate, revoked or hash-mismatched discovery before catalog mutation', async () => {
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
    expect(f.sourceCatalog).not.toHaveBeenCalled();
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
