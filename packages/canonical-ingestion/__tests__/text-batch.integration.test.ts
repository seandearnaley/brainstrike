import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNodeChunker } from '@brainstrike/chunking-worker/node';
import { openIndexer } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { chunkCanonicalRead } from '../src/canonical-chunk-eligibility.js';
import { CanonicalIngestionHost } from '../src/host.js';
import type {
  CanonicalSourceFile,
  CanonicalSourcePort,
  CanonicalSourceScope,
} from '../src/ports.js';
import { createNativeCanonicalPublication } from '../src/scoped-publication.js';

const scope: CanonicalSourceScope = { kind: 'workspace', rootId: 'root' };
const deadlines = { closeMs: 5000 };
const chunker = createNodeChunker({ parser: 'oxc' });
const chunkingOptions = { maxTokens: 256, strategy: 'auto', tokenTrueSizing: true } as const;
const entries = Array.from({ length: 5 }, (_, index) => {
  const content = `export const needle${index} = 'batched needle ${index}';\n`;
  const file: CanonicalSourceFile = {
    embeddingSetId: 'managed-set',
    fileId: `file-${index}`,
    fileName: `file-${index}.ts`,
    relativePath: `file-${index}.ts`,
    rootId: scope.rootId,
    sourcePath: `/root/file-${index}.ts`,
    stat: { mtimeMs: 123, size: Buffer.byteLength(content) },
  };
  return { content, contentHash: createHash('sha256').update(content).digest('hex'), file };
});
type Entry = (typeof entries)[number];
const bindings = entries.map(({ file }) => {
  const { fileName: _name, stat: _stat, ...identity } = file;
  return { ...identity, profile: null };
});

async function withIndex(
  folderBindings: readonly (typeof bindings)[number][],
  work: (
    port: Awaited<ReturnType<typeof openIndexer>>,
    search: () => Promise<readonly string[]>
  ) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-text-batch-'));
  const port = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: folderBindings,
      rootIds: [scope.rootId],
      scopes: [{ embeddingSetId: 'managed-set', kind: 'collection' }],
    },
    deadlines
  );
  const search = async () =>
    (await port.searchScopes({ limit: 50, mode: 'bm25', scopes: [scope], text: 'needle' })).hits
      .map((hit) => hit.fileId)
      .toSorted();
  try {
    await work(port, search);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function scanFolder(
  port: Awaited<ReturnType<typeof openIndexer>>,
  commitScopedTextFiles: (batch: unknown) => Promise<unknown>,
  folder: readonly Entry[]
) {
  const find = (fileId: string) => {
    const entry = folder.find((item) => item.file.fileId === fileId);
    if (!entry) {
      throw new Error('Unexpected canonical file.');
    }
    return entry;
  };
  const publication = createNativeCanonicalPublication(
    { ...port, commitScopedTextFiles } as typeof port,
    [scope]
  );
  const source: CanonicalSourcePort = {
    close: async () => {},
    async *discover() {
      yield { files: folder.map((entry) => entry.file), removed: [] };
      return { errors: [], full: true, truncatedDirectories: [] };
    },
    read: async (current) => {
      const entry = find('fileId' in current ? current.fileId : '');
      return { content: entry.content, stat: entry.file.stat };
    },
  };
  const host = new CanonicalIngestionHost({
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: async ({ files }) =>
        files.map((current) => ({
          ...find(current.fileId).file,
          chunksProcessed: false,
          contentHash: null,
        })),
      prepareManagedSourcesBatch: async () => [],
      removeFiles: async () => {},
      resolveProfile: async () => {
        throw new Error('TEXT never resolves a profile.');
      },
    },
    chunker,
    managedCollectionId: 'managed-set',
    publication,
    source,
  });
  try {
    const receipt = await host.scan({
      batchSize: 64,
      chunkingOptions,
      maxFileBytes: 4_000_000,
      requestId: 'folder',
      scope,
    });
    return { publication, receipt };
  } finally {
    await host.close();
  }
}

it('publishes a folder of TEXT files in one native write, each searchable and acknowledged', async () => {
  await withIndex(bindings, async (port, search) => {
    const commitScopedTextFiles = vi.fn((batch: unknown) => port.commitScopedTextFiles(batch));
    const { publication, receipt } = await scanFolder(port, commitScopedTextFiles, entries);
    expect(receipt).toMatchObject({ reason: 'complete', scanComplete: true });
    expect(commitScopedTextFiles).toHaveBeenCalledOnce();
    expect(await search()).toEqual(entries.map((entry) => entry.file.fileId));
    expect(publication.getReadiness()[0]).toMatchObject({
      publication: { acknowledgedFiles: entries.length },
      scanComplete: true,
    });
  });
});

it('splits a batch of large files across native writes, so each stays within one message', async () => {
  // Eight symbol-dense files of about 480 KB: under the chunker's size limit, and under 4 MB of
  // source together, but their chunks and syntax records serialize past one utility frame.
  const large = Array.from({ length: 8 }, (_, index) => {
    const lines = Array.from(
      { length: 14_000 },
      (_, line) => `export const value${index}_${line} = ${(line * 7919 + index) % 100_003};\n`
    );
    const content = `export const needle${index} = 'batched needle ${index}';\n${lines.join('')}`;
    const file: CanonicalSourceFile = {
      ...entries[0]!.file,
      fileId: `large-${index}`,
      fileName: `large-${index}.ts`,
      relativePath: `large-${index}.ts`,
      sourcePath: `/root/large-${index}.ts`,
      stat: { mtimeMs: 123, size: Buffer.byteLength(content) },
    };
    return { content, contentHash: createHash('sha256').update(content).digest('hex'), file };
  });
  const largeBindings = large.map(({ file }) => {
    const { fileName: _name, stat: _stat, ...identity } = file;
    return { ...identity, profile: null };
  });
  await withIndex(largeBindings, async (port, search) => {
    const commitScopedTextFiles = vi.fn((batch: unknown) => port.commitScopedTextFiles(batch));
    const { publication, receipt } = await scanFolder(port, commitScopedTextFiles, large);
    expect(receipt).toMatchObject({ reason: 'complete', scanComplete: true });
    expect(commitScopedTextFiles.mock.calls.length).toBeGreaterThan(1);
    // Desktop carries each commit in one utility frame of at most 32 MiB of JSON.
    for (const [batch] of commitScopedTextFiles.mock.calls) {
      expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBeLessThanOrEqual(
        32 * 1024 * 1024
      );
    }
    expect(await search()).toEqual(large.map((entry) => entry.file.fileId));
    expect(publication.getReadiness()[0]).toMatchObject({
      publication: { acknowledgedFiles: large.length },
    });
  });
});

it('publishes none of a batch whose file fails, and its scan is write-failed', async () => {
  await withIndex(bindings, async (port, search) => {
    const publication = createNativeCanonicalPublication(port, [scope]);
    const [revoked] = bindings;
    // One file's binding is retired before the batch lands, so the writer refuses that file.
    await port.replaceFileBindings(bindings.filter((binding) => binding !== revoked));
    const ticket = await publication.beginScan({ requestId: 'failing', scope });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const outcome = await chunkCanonicalRead(
          chunker,
          { ...entry, stat: entry.file.stat },
          {
            chunkingOptions,
            requestId: 'failing',
          }
        );
        if (outcome.kind !== 'payload') {
          throw new Error('Fixture source must chunk.');
        }
        expect(outcome.payload.providedChunks.length).toBeGreaterThan(0);
        return { file: entry.file, payload: outcome.payload };
      })
    );
    // The refused file sits in the middle: the files before it must not land either.
    const ordered = [...files.slice(1, 3), ...files.slice(0, 1), ...files.slice(3)];
    await expect(publication.commitTextFiles({ files: ordered, ticket })).rejects.toMatchObject({
      code: 'file-not-authorized',
    });
    expect(await search()).toEqual([]);
    expect(
      await publication.finishScan({
        aborted: false,
        errors: [],
        files: entries.map(({ contentHash, file }) => ({ ...file, contentHash })),
        full: true,
        ticket,
        truncatedDirectories: [],
      })
    ).toMatchObject({ reason: 'write-failed', scanComplete: false });
    expect(publication.getReadiness()[0]).not.toHaveProperty('publication');
    const manifest = await publication.verifyManifest({
      files: entries.map(({ contentHash, file }) => ({ ...file, contentHash })),
      scope,
    });
    expect(manifest.missing).toHaveLength(entries.length);
  });
});
