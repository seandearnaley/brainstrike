import { readFile } from 'node:fs/promises';
import { createNodeChunker } from '@brainstrike/chunking-worker/node';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalIngestionHost } from '../src/host.js';
import type { CanonicalManifestFile, CanonicalSourceFile } from '../src/ports.js';
import { CanonicalWorkspaceSource } from '../src/workspace-source.js';
import type { CanonicalWorkspaceLease } from '../src/workspace-source-ports.js';
import { discoveredFixture, fixture } from './host-test-fixture.js';

describe('utility canonical source ingestion', () => {
  it.each(['registered-then-unresolved', 'unresolved-then-registered', 'same-batch'] as const)(
    'rejects a shared workspace path across %s identity forms before conflicting work',
    async (order) => {
      const f = await discoveredFixture();
      vi.mocked(f.catalog.prepareManagedSourcesBatch).mockResolvedValue([
        { ...f.file, contentHash: f.recorded.sourceHash, fileId: 'distinct-catalog-file-id' },
      ]);
      f.source.discover = async function* () {
        if (order === 'same-batch') {
          yield { discovered: [f.discovered], files: [f.file], removed: [] };
        } else if (order === 'registered-then-unresolved') {
          yield { files: [f.file], removed: [] };
          yield { discovered: [f.discovered], files: [], removed: [] };
        } else {
          yield { discovered: [f.discovered], files: [], removed: [] };
          yield { files: [f.file], removed: [] };
        }
        return f.completion;
      };
      try {
        await expect(f.host.scan(f.request)).rejects.toThrow('repeated a workspace path');
        const admittedFiles = order === 'same-batch' ? 0 : 1;
        expect(f.source.read).toHaveBeenCalledTimes(admittedFiles);
        expect(f.publication.commitTextFiles).toHaveBeenCalledTimes(admittedFiles);
        expect(f.catalog.completeFiles).toHaveBeenCalledTimes(admittedFiles);
        expect(f.catalog.prepareManagedSourcesBatch).toHaveBeenCalledTimes(
          order === 'unresolved-then-registered' ? 1 : 0
        );
        expect(f.publication.finishScan).toHaveBeenCalledWith(
          expect.objectContaining({ errors: [expect.any(String)], full: false })
        );
      } finally {
        await f.host.close();
      }
    }
  );

  it('prepares discovered original source in main before publishing its returned canonical identity', async () => {
    const f = await discoveredFixture();
    try {
      expect((await f.host.scan(f.request)).scanComplete).toBe(true);
      expect(f.catalog.prepareManagedSourcesBatch).toHaveBeenCalledOnce();
      const prepared = vi.mocked(f.catalog.prepareManagedSourcesBatch).mock.calls[0]?.[0];
      expect(prepared).toEqual({
        files: [
          { ...f.discovered, content: f.recorded.content, contentHash: f.recorded.sourceHash },
        ],
        scope: f.request.scope,
      });
      expect(f.catalog.loadAuthorizedBatch).toHaveBeenCalledWith(
        { files: [], scope: f.request.scope },
        expect.anything()
      );
      const publication = vi.mocked(f.publication.commitTextFiles).mock.calls[0]?.[0].files[0];
      expect(publication?.file).toMatchObject(f.file);
      expect(publication?.payload.providedChunks).toEqual(f.recorded.result.chunks);
      expect(f.catalog.completeFiles).toHaveBeenCalledWith(
        {
          files: [
            {
              chunkCount: f.recorded.result.chunks.length,
              contentHash: f.recorded.sourceHash,
              fileId: f.file.fileId,
            },
          ],
          scope: f.request.scope,
        },
        expect.anything()
      );
    } finally {
      await f.host.close();
    }
  });

  it('waits for main preparation and trusted binding acknowledgement before publication', async () => {
    const f = await discoveredFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(f.catalog.prepareManagedSourcesBatch).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return [{ ...f.file, contentHash: f.recorded.sourceHash }];
    });
    let settled = false;
    const scan = f.host.scan(f.request).finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      expect(settled).toBe(false);
      expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      expect(vi.mocked(f.source.read).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(f.catalog.prepareManagedSourcesBatch).mock.invocationCallOrder[0] ?? 0
      );
      release.resolve();
      expect((await scan).scanComplete).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([scan]);
      await f.host.close();
    }
  });

  it('cancels held main preparation only after physical settlement and suppresses publication', async () => {
    const f = await discoveredFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(f.catalog.prepareManagedSourcesBatch).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return [{ ...f.file, contentHash: f.recorded.sourceHash }];
    });
    const scan = f.host.scan(f.request);
    const outcome = scan.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ error, status: 'rejected' as const })
    );
    let cancellation: Promise<void> | undefined;
    let cancelSettled = false;
    try {
      await entered.promise;
      cancellation = f.host.cancel(f.request.requestId).then(() => {
        cancelSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelSettled).toBe(false);
      expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      release.resolve();
      await cancellation;
      expect(await outcome).toMatchObject({ error: { name: 'AbortError' }, status: 'rejected' });
      expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      expect(f.publication.finishScan).toHaveBeenCalledWith(
        expect.objectContaining({ aborted: true })
      );
    } finally {
      release.resolve();
      await Promise.allSettled([outcome, ...(cancellation ? [cancellation] : [])]);
      await f.host.close();
    }
  });

  it.each([
    'missing',
    'extra',
    'root',
    'relative-path',
    'name',
    'source-path',
    'hash',
    'membership',
    'blank-id',
  ] as const)('rejects a %s catalog preparation reply before publication', async (invalid) => {
    const f = await discoveredFixture();
    const binding: CanonicalManifestFile = { ...f.file, contentHash: f.recorded.sourceHash };
    const replacements: Partial<CanonicalManifestFile> =
      invalid === 'root'
        ? { rootId: 'foreign-root' }
        : invalid === 'relative-path'
          ? { relativePath: 'foreign.ts' }
          : invalid === 'name'
            ? { fileName: 'foreign.ts' }
            : invalid === 'source-path'
              ? { sourcePath: 'foreign.ts' }
              : invalid === 'hash'
                ? { contentHash: 'foreign-hash' }
                : invalid === 'membership'
                  ? { embeddingSetId: null }
                  : invalid === 'blank-id'
                    ? { fileId: '' }
                    : {};
    const bindings =
      invalid === 'missing'
        ? []
        : invalid === 'extra'
          ? [binding, { ...binding, fileId: 'extra', relativePath: 'extra.ts' }]
          : [{ ...binding, ...replacements }];
    vi.mocked(f.catalog.prepareManagedSourcesBatch).mockResolvedValue(bindings);
    try {
      await expect(f.host.scan(f.request)).rejects.toThrow(/Canonical prepar/u);
      expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      expect(f.publication.finishScan).toHaveBeenCalledWith(
        expect.objectContaining({ errors: [expect.any(String)], full: false })
      );
    } finally {
      await f.host.close();
    }
  });

  it('counts unresolved discoveries in the existing explicit batch bound', async () => {
    const f = await discoveredFixture();
    f.source.discover = async function* () {
      yield {
        discovered: [f.discovered, { ...f.discovered, relativePath: 'second.ts' }],
        files: [],
        removed: [],
      };
      return f.completion;
    };
    try {
      await expect(f.host.scan({ ...f.request, batchSize: 1 })).rejects.toThrow('batch bound');
      expect(f.source.read).not.toHaveBeenCalled();
      expect(f.catalog.prepareManagedSourcesBatch).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it('rejects a foreign discovery root before reading any original source', async () => {
    const f = await discoveredFixture();
    f.source.discover = async function* () {
      yield { discovered: [{ ...f.discovered, rootId: 'foreign-root' }], files: [], removed: [] };
      return f.completion;
    };
    try {
      await expect(f.host.scan(f.request)).rejects.toThrow('outside its workspace binding');
      expect(f.source.read).not.toHaveBeenCalled();
      expect(f.catalog.prepareManagedSourcesBatch).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it('rejects a repeated unresolved path before its second read or preparation', async () => {
    const f = await discoveredFixture();
    f.source.discover = async function* () {
      yield { discovered: [f.discovered], files: [], removed: [] };
      yield { discovered: [f.discovered], files: [], removed: [] };
      return f.completion;
    };
    try {
      await expect(f.host.scan(f.request)).rejects.toThrow('repeated a workspace path');
      expect(f.source.read).toHaveBeenCalledOnce();
      expect(f.catalog.prepareManagedSourcesBatch).toHaveBeenCalledOnce();
      expect(f.publication.commitTextFiles).toHaveBeenCalledOnce();
    } finally {
      await f.host.close();
    }
  });

  it('rejects a prepared canonical ID already published in the same scan', async () => {
    const f = await discoveredFixture();
    const second = { ...f.discovered, relativePath: 'second.ts', sourcePath: 'second.ts' };
    vi.mocked(f.catalog.prepareManagedSourcesBatch).mockResolvedValue([
      {
        ...f.file,
        contentHash: f.recorded.sourceHash,
        relativePath: second.relativePath,
        sourcePath: second.sourcePath,
      },
    ]);
    f.source.discover = async function* () {
      yield { files: [f.file], removed: [] };
      yield { discovered: [second], files: [], removed: [] };
      return f.completion;
    };
    try {
      await expect(f.host.scan(f.request)).rejects.toThrow('repeated a file identity');
      expect(f.catalog.prepareManagedSourcesBatch).toHaveBeenCalledOnce();
      expect(f.publication.commitTextFiles).toHaveBeenCalledOnce();
      expect(f.catalog.completeFiles).toHaveBeenCalledOnce();
    } finally {
      await f.host.close();
    }
  });

  it('rejects repeated canonical IDs in one preparation reply before either file publishes', async () => {
    const f = await discoveredFixture();
    const second = { ...f.discovered, relativePath: 'second.ts', sourcePath: 'second.ts' };
    f.source.discover = async function* () {
      yield { discovered: [f.discovered, second], files: [], removed: [] };
      return f.completion;
    };
    const binding = { ...f.file, contentHash: f.recorded.sourceHash };
    vi.mocked(f.catalog.prepareManagedSourcesBatch).mockResolvedValue([
      binding,
      { ...binding, relativePath: second.relativePath, sourcePath: second.sourcePath },
    ]);
    try {
      await expect(f.host.scan(f.request)).rejects.toThrow('exact discovered batch');
      expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it('does not publish when main preparation or its binding acknowledgement fails', async () => {
    const f = await discoveredFixture();
    const failure = new Error('Real source committed but trusted binding acknowledgement failed.');
    vi.mocked(f.catalog.prepareManagedSourcesBatch).mockRejectedValue(failure);
    try {
      await expect(f.host.scan(f.request)).rejects.toBe(failure);
      expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it('publishes the actual recorded chunks and graph and completes PG metadata after native writes', async () => {
    const f = await fixture();
    expect((await f.host.scan(f.request)).scanComplete).toBe(true);
    const call = vi.mocked(f.publication.commitTextFiles).mock.calls[0]?.[0].files[0];
    expect(call?.payload.providedChunks).toEqual(f.recorded.result.chunks);
    expect(call?.payload.syntax?.symbols).toMatchObject([
      { fileRecordId: f.recorded.fileId, name: 'createArtifactReaderModelProjection' },
    ]);
    expect(call?.file).toMatchObject({ fileId: f.recorded.fileId, rootId: 'root' });
    expect(f.catalog.completeFiles).toHaveBeenCalledOnce();
    expect(f.catalog.resolveProfile).not.toHaveBeenCalled();
    expect(vi.mocked(f.catalog.completeFiles).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(f.publication.commitTextFiles).mock.invocationCallOrder[0] ?? 0
    );
  });

  it('uses the existing stat-skip principle only when native coverage agrees', async () => {
    const f = await fixture();
    vi.mocked(f.catalog.loadAuthorizedBatch).mockResolvedValue([
      { ...f.catalogFile, chunksProcessed: true },
    ]);
    vi.mocked(f.publication.verifyManifest).mockResolvedValue({
      acknowledged: [],
      changed: [],
      complete: true,
      missing: [],
      storeId: 'store',
      unexpected: [],
    });
    await f.host.scan(f.request);
    expect(f.source.read).not.toHaveBeenCalled();
    expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
  });

  it('forces missing native stat-cache files through the canonical read/parser', async () => {
    const f = await fixture();
    vi.mocked(f.catalog.loadAuthorizedBatch).mockResolvedValue([
      { ...f.catalogFile, chunksProcessed: true },
    ]);
    await f.host.scan(f.request);
    expect(f.source.read).toHaveBeenCalledOnce();
    expect(f.publication.commitTextFiles).toHaveBeenCalledOnce();
  });

  it('removes native data before authoritative catalog invalidation', async () => {
    const f = await fixture();
    f.source.discover = async function* () {
      yield { files: [], removed: [f.file] };
      return f.completion;
    };
    await f.host.scan(f.request);
    expect(f.order).toEqual(['native-remove', 'catalog-remove']);
  });

  it('closes admission and joins physical publication before cancellation settles', async () => {
    const f = await fixture();
    const admitted = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    vi.mocked(f.publication.commitTextFiles).mockImplementation(async () => {
      admitted.resolve();
      await commit.promise;
    });
    const scan = f.host.scan(f.request);
    const rejected = expect(scan).rejects.toMatchObject({ name: 'AbortError' });
    await admitted.promise;
    let joined = false;
    const cancel = f.host.cancel(f.request.requestId).then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    await expect(f.host.scan({ ...f.request, requestId: 'scan-2' })).rejects.toThrow('owned');
    commit.resolve();
    await cancel;
    await rejected;
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    expect(f.publication.finishScan).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true })
    );
    expect(f.publication.abortScan).toHaveBeenCalledOnce();
  });

  it('joins cancellation during manifest completion and refuses a stale complete receipt', async () => {
    const f = await fixture();
    const admitted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    vi.mocked(f.publication.finishScan).mockImplementation(async () => {
      admitted.resolve();
      await finish.promise;
      return { reason: 'complete', scanComplete: true, ticket: f.ticket };
    });
    const scan = f.host.scan(f.request);
    const rejected = expect(scan).rejects.toMatchObject({ name: 'AbortError' });
    await admitted.promise;
    let joined = false;
    const cancel = f.host.cancel(f.request.requestId).then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    finish.resolve();
    await cancel;
    await rejected;
    expect(f.publication.abortScan).toHaveBeenCalledOnce();
  });

  it('consumes a failed scan and leaves completion metadata untouched', async () => {
    const f = await fixture();
    vi.mocked(f.source.read).mockRejectedValue(new Error('Bounded source read failed'));
    await expect(f.host.scan(f.request)).rejects.toThrow('Bounded source read failed');
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    expect(f.publication.finishScan).toHaveBeenCalledWith(
      expect.objectContaining({ errors: ['Bounded source read failed'] })
    );
  });

  it('refuses a repeated discovery before publishing the duplicate file', async () => {
    const f = await fixture();
    f.source.discover = async function* () {
      yield { files: [f.file], removed: [] };
      yield { files: [f.file], removed: [] };
      return f.completion;
    };
    await expect(f.host.scan(f.request)).rejects.toThrow('repeated a file identity');
    expect(f.publication.commitTextFiles).toHaveBeenCalledOnce();
  });

  it('joins source iterator retirement before releasing cancelled ownership', async () => {
    const f = await fixture();
    const readAdmitted = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const retiring = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    vi.mocked(f.source.read).mockImplementation(async () => {
      readAdmitted.resolve();
      await read.promise;
      return { content: f.recorded.content, stat: f.file.stat };
    });
    f.source.discover = async function* () {
      try {
        yield { files: [f.file], removed: [] };
        return f.completion;
      } finally {
        retiring.resolve();
        await retired.promise;
      }
    };
    const scan = f.host.scan(f.request);
    const rejection = expect(scan).rejects.toMatchObject({ name: 'AbortError' });
    await readAdmitted.promise;
    let joined = false;
    const cancel = f.host.cancel(f.request.requestId).then(() => {
      joined = true;
    });
    read.resolve();
    await retiring.promise;
    expect(joined).toBe(false);
    expect(f.publication.finishScan).not.toHaveBeenCalled();
    retired.resolve();
    await cancel;
    await rejection;
    expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
  });

  it('settles a cancellation once the scan it cancelled ends, which reports its own failure', async () => {
    const f = await fixture();
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('Native transaction failed');
    vi.mocked(f.publication.commitTextFiles).mockImplementation(async () => {
      admitted.resolve();
      await release.promise;
      throw failure;
    });
    const scan = f.host.scan(f.request);
    const rejection = expect(scan).rejects.toBe(failure);
    await admitted.promise;
    let cancelled = false;
    const cancel = f.host.cancel(f.request.requestId).then(() => {
      cancelled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(false);
    release.resolve();
    await rejection;
    await expect(cancel).resolves.toBeUndefined();
  });

  it('drains yielding finally cleanup before releasing cancellation without publishing cleanup batches', async () => {
    const f = await fixture();
    const readAdmitted = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const retiring = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    let generatorRetired = false;
    vi.mocked(f.source.read).mockImplementation(async () => {
      readAdmitted.resolve();
      await read.promise;
      return { content: f.recorded.content, stat: f.file.stat };
    });
    f.source.discover = async function* () {
      try {
        yield { files: [f.file], removed: [] };
        return f.completion;
      } finally {
        yield { files: [f.file], removed: [] };
        retiring.resolve();
        await retired.promise;
        generatorRetired = true;
      }
    };
    const scan = f.host.scan(f.request);
    const outcome = scan.then(
      () => undefined,
      (error: unknown) => error
    );
    await readAdmitted.promise;
    const cancel = f.host.cancel(f.request.requestId);
    read.resolve();
    expect(
      await Promise.race([
        retiring.promise.then(() => 'retiring'),
        cancel.then(() => 'cancel-resolved'),
      ])
    ).toBe('retiring');
    expect(generatorRetired).toBe(false);
    await expect(f.host.scan({ ...f.request, requestId: 'scan-2' })).rejects.toThrow('owned');
    retired.resolve();
    await cancel;
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(generatorRetired).toBe(true);
    expect(f.source.read).toHaveBeenCalledOnce();
    expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
  });

  it('reports primary and yielding-cleanup failures to the scan when cancellation arrives during retirement', async () => {
    const f = await fixture();
    const primary = new Error('Original read failed');
    const cleanup = new Error('Physical source retirement failed');
    const retiring = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    vi.mocked(f.source.read).mockRejectedValue(primary);
    f.source.discover = async function* () {
      try {
        yield { files: [f.file], removed: [] };
        return f.completion;
      } finally {
        yield { files: [], removed: [f.file] };
        retiring.resolve();
        await retired.promise;
      }
    };
    const scan = f.host.scan(f.request);
    const outcome = scan.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(
      await Promise.race([
        retiring.promise.then(() => 'retiring'),
        outcome.then(() => 'scan-settled'),
      ])
    ).toBe('retiring');
    const cancelOutcome = f.host.cancel(f.request.requestId).then(
      () => undefined,
      (error: unknown) => error
    );
    retired.reject(cleanup);
    expect(await outcome).toMatchObject({ errors: [primary, cleanup] });
    expect(await cancelOutcome).toBeUndefined();
    expect(f.publication.removeFiles).not.toHaveBeenCalled();
    await expect(f.host.scan({ ...f.request, requestId: 'scan-2' })).rejects.toThrow('owned');
    await f.host.close();
  });

  it('rejects unauthorized source bindings before source mutation or publication', async () => {
    const f = await fixture();
    vi.mocked(f.catalog.loadAuthorizedBatch).mockResolvedValue([
      { ...f.catalogFile, rootId: 'other-root' },
    ]);
    await expect(f.host.scan(f.request)).rejects.toThrow('authoritative catalog');
    expect(f.source.read).not.toHaveBeenCalled();
    expect(f.catalog.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
  });

  it('retires a scan whose abort notice failed, which the scan alone reports', async () => {
    const f = await fixture();
    const admitted = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    vi.mocked(f.publication.commitTextFiles).mockImplementation(async () => {
      admitted.resolve();
      await commit.promise;
    });
    const refused = new Error('Canonical publication ticket is stale or belongs to another store.');
    vi.mocked(f.publication.abortScan).mockRejectedValue(refused);
    const scan = f.host.scan(f.request).catch((error: unknown) => error);
    await admitted.promise;
    const retirement = f.host.close();
    commit.resolve();
    await expect(retirement).resolves.toBeUndefined();
    expect(await scan).toMatchObject({ errors: [expect.anything(), refused] });
    expect(f.publication.abortScan).toHaveBeenCalledOnce();
    expect(f.source.close).toHaveBeenCalledOnce();
  });

  it('keeps admission closed after failed source retirement and permits explicit cleanup retry', async () => {
    const f = await fixture();
    const failure = new Error('Watcher retirement failed');
    vi.mocked(f.source.close).mockRejectedValueOnce(failure);
    await expect(f.host.close()).rejects.toMatchObject({ errors: [failure] });
    await expect(f.host.scan(f.request)).rejects.toThrow('closed');
    await f.host.close();
    expect(f.source.close).toHaveBeenCalledTimes(2);
  });

  it('refuses truncated discovery readiness', async () => {
    const f = await fixture();
    f.source.discover = async function* () {
      yield { files: [f.file], removed: [] };
      return { ...f.completion, truncatedDirectories: ['src'] };
    };
    await expect(f.host.scan(f.request)).rejects.toThrow('incomplete');
  });
});

describe('chunker-ineligible content through the canonical scan', () => {
  // Recorded: one 548 KB data file blocked the whole index with "Canonical chunking
  // skipped: File too large: 548KB (max: 500KB)"; lockfiles and generated files skip too.
  it.each([
    ['dependency-manifest', 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
    ['too-large', 'pairs.json', `[${'{"left":"a","right":"b"},'.repeat(22_000)}{}]`],
    ['generated-content', 'generated.ts', 'export const value = 1;\n'.repeat(2000)],
  ] as const)(
    'completes the eligible manifest and reports a %s exclusion for %s',
    async (reason, fileName, content) => {
      const f = await fixture();
      const skippedFile: CanonicalSourceFile = {
        ...f.file,
        fileId: 'existing-ineligible',
        fileName,
        relativePath: fileName,
        sourcePath: fileName,
      };
      vi.mocked(f.catalog.loadAuthorizedBatch).mockImplementation(async (request) =>
        request.files.map((entry) => ({
          ...f.file,
          chunksProcessed: false,
          contentHash: 'unused',
          ...entry,
        }))
      );
      f.source.discover = async function* () {
        yield { files: [f.file, skippedFile], removed: [] };
        return { errors: [], full: true, truncatedDirectories: [] };
      };
      vi.mocked(f.source.read).mockImplementation(async (file) =>
        'fileId' in file && file.fileId === skippedFile.fileId
          ? { content, stat: { mtimeMs: 123, size: Buffer.byteLength(content) } }
          : { content: f.recorded.content, stat: f.file.stat }
      );
      // Desktop's read bound (getFileSizeConfig().maxFileSize) admits files above the chunker's.
      const receipt = await f.host.scan({ ...f.request, maxFileBytes: 1024 * 1024 });
      expect(receipt.scanComplete).toBe(true);
      expect(receipt).toMatchObject({
        excluded: [{ fileId: skippedFile.fileId, reason, relativePath: fileName, rootId: 'root' }],
      });
      expect(f.publication.commitTextFiles).toHaveBeenCalledOnce();
      expect(f.publication.finishScan).toHaveBeenCalledWith(
        expect.objectContaining({
          files: [expect.objectContaining({ fileId: f.file.fileId })],
          full: true,
        })
      );
      expect(f.publication.removeFiles).toHaveBeenCalledExactlyOnceWith({
        files: [expect.objectContaining({ fileId: skippedFile.fileId })],
        ticket: f.ticket,
      });
      expect(f.publication.abortScan).not.toHaveBeenCalled();
    }
  );
});

describe('workspace content eligibility through the canonical scan', () => {
  it.each([
    ['null-byte-content', false],
    ['null-byte-content', true],
    ['binary-content', false],
    ['binary-content', true],
  ] as const)(
    'completes the eligible text manifest and reports %s exclusion (managed=%s)',
    async (reason, managed) => {
      const f = await fixture();
      const captured = JSON.parse(
        await readFile(
          new URL('./fixtures/null-byte-workspace-source.json', import.meta.url),
          'utf8'
        )
      ) as { fileName: string; content: string };
      const excludedFile: CanonicalSourceFile = {
        ...f.file,
        fileId: 'existing-unsupported',
        fileName: captured.fileName,
        relativePath: captured.fileName,
        sourcePath: captured.fileName,
      };
      const excludedContent =
        reason === 'null-byte-content'
          ? captured.content
          : captured.content.replaceAll('\0', '\u0001');
      const entries = [f.file.fileName, captured.fileName];
      const lease: CanonicalWorkspaceLease = {
        canonicalPath: '/workspace',
        generation: 'actual-borrow',
        listDir: async () => ({
          entries: entries.map((name) => ({
            isDirectory: false,
            isFile: true,
            isSymbolicLink: false,
            lastModified: 123,
            name,
            size: 100,
          })),
          inspected: 2,
          truncated: false,
        }),
        readFile: async (relativePath) => ({
          content: Buffer.from(
            relativePath === captured.fileName ? excludedContent : f.recorded.content
          ),
          status: 'ok',
        }),
        retire: async () => {},
        rootId: 'root',
        signal: new AbortController().signal,
        subscribe: async () => ({ close: async () => {} }),
      };
      const source = new CanonicalWorkspaceSource({
        indexingPolicyPreset: 'balanced',
        inventory: {
          loadFiles: async () => (managed ? [excludedFile] : []),
        },
        lease,
      });
      vi.mocked(f.catalog.prepareManagedSourcesBatch).mockImplementation(async ({ files }) =>
        files.map((file) => ({ ...f.file, ...file }))
      );
      const host = new CanonicalIngestionHost({
        catalog: f.catalog,
        chunker: createNodeChunker({ parser: 'oxc' }),
        managedCollectionId: f.file.embeddingSetId,
        publication: f.publication,
        source,
      });
      try {
        const receipt = await host.scan(f.request);
        expect(receipt.scanComplete).toBe(true);
        expect(receipt).toMatchObject({
          excluded: [
            {
              fileId: managed ? excludedFile.fileId : null,
              reason,
              relativePath: captured.fileName,
              rootId: 'root',
            },
          ],
        });
        expect(f.catalog.prepareManagedSourcesBatch).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            files: [expect.objectContaining({ fileName: f.file.fileName })],
          }),
          expect.anything()
        );
        expect(f.publication.commitTextFiles).toHaveBeenCalledOnce();
        expect(f.publication.finishScan).toHaveBeenCalledWith(
          expect.objectContaining({
            errors: [],
            files: [expect.objectContaining({ fileName: f.file.fileName })],
            full: true,
          })
        );
        expect(f.publication.abortScan).not.toHaveBeenCalled();
        if (managed) {
          expect(f.publication.removeFiles).toHaveBeenCalledExactlyOnceWith({
            files: [expect.objectContaining({ fileId: excludedFile.fileId })],
            ticket: f.ticket,
          });
          expect(f.catalog.removeFiles).toHaveBeenCalledExactlyOnceWith(
            {
              files: [expect.objectContaining({ fileId: excludedFile.fileId })],
              scope: f.request.scope,
            },
            expect.anything()
          );
          expect(f.order).toEqual(['native-remove', 'catalog-remove']);
        } else {
          expect(f.publication.removeFiles).not.toHaveBeenCalled();
          expect(f.catalog.removeFiles).not.toHaveBeenCalled();
        }
      } finally {
        await host.close();
      }
    }
  );

  it('does not infer eligibility from a generic error message', async () => {
    const f = await fixture();
    const failure = new Error('File contains null bytes and cannot be indexed.');
    vi.mocked(f.source.read).mockRejectedValueOnce(failure);
    try {
      await expect(f.host.scan(f.request)).rejects.toBe(failure);
      expect(f.publication.abortScan).toHaveBeenCalledOnce();
      expect(f.catalog.removeFiles).not.toHaveBeenCalled();
      expect(f.catalog.applyManagedCacheBatch).not.toHaveBeenCalled();
      expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });
});
