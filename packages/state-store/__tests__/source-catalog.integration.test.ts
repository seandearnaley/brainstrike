import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { BLOBS_DIR, largeText, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(cleanupDirs);
const source = (content: string) => ({
  content,
  contentHash: createHash('sha256').update(content).digest('hex'),
  fileName: 'acceptance.txt',
  path: 'acceptance.txt',
  stat: { mtimeMs: 1_728_810_000_000, size: Buffer.byteLength(content) },
});

test('the canonical source belongs to the existing root writer and retains its ID and bytes across reopen', async () => {
  const directory = freshDir('source-catalog');
  const indexer = new TruthIndexer(directory);
  let store = await StateStore.open(directory, { indexer });
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    const original = source('An actual checked workspace file.\n'.repeat(1000));
    const prepared = await store.sourceCatalog({
      embeddingSetId: null,
      files: [original],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    const file = prepared.files[0];
    expect(file).toMatchObject({
      contentHash: original.contentHash,
      path: original.path,
      rootId: 'root-alpha',
    });
    expect(file?.fileId).toBeTruthy();
    await store.close();
    store = await StateStore.open(directory, { indexer });
    const reread = await store.sourceCatalog({
      fileIds: [file!.fileId],
      maxContentBytes: original.stat.size,
      operation: 'read',
    });
    expect(reread.files[0]).toMatchObject({ ...file, content: original.content });
    const repeated = await store.sourceCatalog({
      embeddingSetId: null,
      files: [original],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    expect(repeated.files[0]?.fileId).toBe(file?.fileId);
    await store.workspaceRoots({ mountedPaths: [], operation: 'disconnect-except' });
    await expect(
      store.sourceCatalog({
        embeddingSetId: null,
        files: [original],
        operation: 'prepare',
        rootId: 'root-alpha',
      })
    ).rejects.toThrow();
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toHaveLength(1);
  } finally {
    await store.close();
    indexer.close();
  }
});

test('stale completion and removal cannot mutate a replaced source', async () => {
  const directory = freshDir('source-catalog-stale');
  const indexer = new TruthIndexer(directory);
  const store = await StateStore.open(directory, { indexer });
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    const initial = await store.sourceCatalog({
      embeddingSetId: null,
      files: [source('first')],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    const original = initial.files[0]!;
    const updated = await store.sourceCatalog({
      embeddingSetId: null,
      files: [source('changed')],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    expect(updated.files[0]?.fileId).toBe(original.fileId);
    await expect(
      store.sourceCatalog({ files: [{ chunkCount: 1, expected: original }], operation: 'complete' })
    ).rejects.toThrow();
    await expect(store.sourceCatalog({ files: [original], operation: 'remove' })).rejects.toThrow();
    const current = updated.files[0]!;
    const completed = await store.sourceCatalog({
      files: [{ chunkCount: 1, expected: current }],
      operation: 'complete',
    });
    expect(completed.files[0]?.chunksProcessed).toBe(true);
    expect(existsSync(join(directory, BLOBS_DIR, original.contentHash))).toBe(false);
    await store.sourceCatalog({ files: [current], operation: 'remove' });
    expect(existsSync(join(directory, BLOBS_DIR, current.contentHash))).toBe(false);
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toEqual([]);
  } finally {
    await store.close();
    indexer.close();
  }
});

test('event erasure retains bytes still owned by a canonical source', async () => {
  const directory = freshDir('source-catalog-gc');
  const indexer = new TruthIndexer(directory);
  const store = await StateStore.open(directory, { indexer });
  const original = source('Shared checked-file content.\n'.repeat(1000));
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    const prepared = await store.sourceCatalog({
      embeddingSetId: null,
      files: [original],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    const text = largeText(original.content);
    if (!text.blob) {
      throw new Error('Expected a content-addressed runtime payload');
    }
    await store.append([
      {
        blobs: [text.blob],
        event: { type: 'file.read', ...text.fields },
        threadId: 'thread-alpha',
      },
    ]);
    expect((await store.purge('thread-alpha', 1)).blobsDeleted).toEqual([]);
    expect(readFileSync(join(directory, BLOBS_DIR, original.contentHash), 'utf8')).toBe(
      original.content
    );
    const file = prepared.files[0];
    if (!file) {
      throw new Error('Canonical source was not committed');
    }
    expect(
      (
        await store.sourceCatalog({
          fileIds: [file.fileId],
          maxContentBytes: original.stat.size,
          operation: 'read',
        })
      ).files[0]?.content
    ).toBe(original.content);
  } finally {
    await store.close();
    indexer.close();
  }
});

test('current-format export and import retain canonical source-only bytes', async () => {
  const directory = freshDir('source-catalog-export');
  const indexer = new TruthIndexer(directory);
  const store = await StateStore.open(directory, { indexer });
  const original = source('Source-only content, with no transcript reference.');
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    const prepared = await store.sourceCatalog({
      embeddingSetId: null,
      files: [original],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    const bundle = join(freshDir('source-catalog-bundle'), 'snapshot');
    const manifest = await store.exportTo(bundle);
    expect(
      manifest.files.find((file) => file.path === `${BLOBS_DIR}/${original.contentHash}`)
    ).toMatchObject({ bytes: original.stat.size, sha256: original.contentHash });
    const importedRoot = freshDir('source-catalog-import');
    StateStore.importBundle(bundle, importedRoot);
    const imported = await StateStore.open(importedRoot, { onForeignLock: () => true });
    try {
      const file = prepared.files[0];
      if (!file) {
        throw new Error('Canonical source was not committed');
      }
      expect(
        (
          await imported.sourceCatalog({
            fileIds: [file.fileId],
            maxContentBytes: original.stat.size,
            operation: 'read',
          })
        ).files[0]?.content
      ).toBe(original.content);
    } finally {
      await imported.close();
    }
  } finally {
    await store.close();
    indexer.close();
  }
});

test('a held source deletion survives reopen and physical cleanup rejoins the existing collector', async () => {
  const directory = freshDir('source-catalog-held-delete');
  const firstIndexer = new TruthIndexer(directory);
  const store = await StateStore.open(directory, { indexer: firstIndexer });
  const original = source('Retained while another reader holds blob collection.');
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    const prepared = await store.sourceCatalog({
      embeddingSetId: null,
      files: [original],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    const file = prepared.files[0];
    if (!file) {
      throw new Error('Canonical source was not committed');
    }
    // Closing this owner before the borrowed hold releases leaves the durable deletion receipt.
    store.holdBlobGc();
    await store.sourceCatalog({ files: [file], operation: 'remove' });
    expect(existsSync(join(directory, BLOBS_DIR, original.contentHash))).toBe(true);
  } finally {
    await store.close();
    firstIndexer.close();
  }
  const indexer = new TruthIndexer(directory);
  const reopened = await StateStore.open(directory, { indexer });
  try {
    expect(
      (await reopened.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toEqual([]);
    expect(existsSync(join(directory, BLOBS_DIR, original.contentHash))).toBe(false);
  } finally {
    await reopened.close();
    indexer.close();
  }
});

test('source erasure preserves shared transcript bytes until the final transcript purge', async () => {
  const directory = freshDir('source-catalog-shared-delete');
  const indexer = new TruthIndexer(directory);
  const store = await StateStore.open(directory, { indexer });
  const original = source('Shared checked-file content.\n'.repeat(1000));
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    const prepared = await store.sourceCatalog({
      embeddingSetId: null,
      files: [original],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    const file = prepared.files[0];
    const text = largeText(original.content);
    if (!(file && text.blob)) {
      throw new Error('Expected a committed source and runtime blob');
    }
    await store.append([
      {
        blobs: [text.blob],
        event: { type: 'file.read', ...text.fields },
        threadId: 'thread-alpha',
      },
    ]);
    await store.sourceCatalog({ files: [file], operation: 'remove' });
    expect(readFileSync(join(directory, BLOBS_DIR, original.contentHash), 'utf8')).toBe(
      original.content
    );
    expect((await store.purge('thread-alpha', 1)).blobsDeleted).toEqual([original.contentHash]);
    expect(existsSync(join(directory, BLOBS_DIR, original.contentHash))).toBe(false);
  } finally {
    await store.close();
    indexer.close();
  }
});

test('forgetting a captured root erases its sources and bytes, but refuses another path', async () => {
  const directory = freshDir('source-catalog-forget-root');
  const indexer = new TruthIndexer(directory);
  const store = await StateStore.open(directory, { indexer });
  const original = source('Forget this managed source, not the other workspace.');
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Beta', path: '/disposable/Beta', preferredId: 'root-beta' },
    });
    await store.sourceCatalog({
      embeddingSetId: null,
      files: [original],
      operation: 'prepare',
      rootId: 'root-alpha',
    });
    await expect(
      store.workspaceRoots({
        operation: 'delete',
        paths: ['/disposable/Beta'],
        rootId: 'root-alpha',
      })
    ).rejects.toThrow();
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toHaveLength(1);
    await store.workspaceRoots({
      operation: 'delete',
      paths: ['/disposable/Alpha'],
      rootId: 'root-alpha',
    });
    expect(
      (await store.workspaceRoots({ operation: 'list' })).roots.map((root) => root.id)
    ).toEqual(['root-beta']);
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toEqual([]);
    expect(existsSync(join(directory, BLOBS_DIR, original.contentHash))).toBe(false);
  } finally {
    await store.close();
    indexer.close();
  }
});
