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
const bindings = entries.map(({ file }) => {
  const { fileName: _name, stat: _stat, ...identity } = file;
  return { ...identity, profile: null };
});
const entryFor = (fileId: string) => {
  const entry = entries.find((item) => item.file.fileId === fileId);
  if (!entry) {
    throw new Error('Unexpected canonical file.');
  }
  return entry;
};

async function withIndex(
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
      fileBindings: bindings,
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

it('publishes a folder of TEXT files in one native write, each searchable and acknowledged', async () => {
  await withIndex(async (port, search) => {
    const commitScopedTextFiles = vi.fn((batch: unknown) => port.commitScopedTextFiles(batch));
    const publication = createNativeCanonicalPublication({ ...port, commitScopedTextFiles }, [
      scope,
    ]);
    const source: CanonicalSourcePort = {
      close: async () => {},
      async *discover() {
        yield { files: entries.map((entry) => entry.file), removed: [] };
        return { errors: [], full: true, truncatedDirectories: [] };
      },
      read: async (current) => {
        const entry = entryFor('fileId' in current ? current.fileId : '');
        return { content: entry.content, stat: entry.file.stat };
      },
    };
    const host = new CanonicalIngestionHost({
      catalog: {
        applyManagedCacheBatch: async () => {},
        completeFiles: async () => {},
        loadAuthorizedBatch: async ({ files }) =>
          files.map((current) => ({
            ...entryFor(current.fileId).file,
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
        maxFileBytes: 100_000,
        requestId: 'folder',
        scope,
      });
      expect(receipt).toMatchObject({ reason: 'complete', scanComplete: true });
      expect(commitScopedTextFiles).toHaveBeenCalledOnce();
      expect(await search()).toEqual(entries.map((entry) => entry.file.fileId));
      expect(publication.getReadiness()[0]).toMatchObject({
        publication: { acknowledgedFiles: entries.length },
        scanComplete: true,
      });
    } finally {
      await host.close();
    }
  });
});

it('publishes none of a batch whose file fails, and its scan is write-failed', async () => {
  await withIndex(async (port, search) => {
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
