// Canvas-shaped C-blob coverage at the generic run-event seam, not application Canvas persistence wiring.
// Metadata follows migration 082; large HTML uses the existing top-level blob reference convention.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { BLOBS_DIR, largeText, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(() => cleanupDirs());

test('Canvas version metadata and shared HTML survive bundle import; collection waits for the last version', async () => {
  const threadId = 'canvas-thread';
  const html = `<!doctype html><html><body>${'<p>Canvas content</p>'.repeat(1000)}</body></html>`;
  const hash = createHash('sha256').update(html).digest('hex');
  const text = largeText(html);
  const blob = text.blob;
  if (!blob) {
    throw new Error('Canvas fixture must create a content-addressed HTML blob');
  }
  const metadata = {
    canvas_id: '019a0000-0000-7000-8000-000000000001',
    created_at: '2026-10-04T00:00:00.000Z',
    resource_id: 'canvas-resource',
    thread_id: threadId,
    title: 'Shared HTML, distinct versions',
    type: 'canvas-version',
  };
  const versions = [
    {
      ...metadata,
      ...text.fields,
      created_by: 'assistant',
      id: '019a0000-0000-7000-8000-000000000002',
      version: 1,
    },
    {
      ...metadata,
      ...text.fields,
      created_by: 'user',
      id: '019a0000-0000-7000-8000-000000000003',
      version: 2,
    },
  ];
  const root = freshDir('canvas-blobs');
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer });
  try {
    await store.append(
      versions.map((event, i) => ({
        blobs: i === 0 ? [blob] : [],
        event,
        threadId,
      }))
    );
    const before = await store.read(threadId);
    expect(before.map((row) => row.event)).toEqual(
      versions.map((event, i) => ({ seq: i + 1, ...event }))
    );
    expect(before.map((row) => row.event['blob'])).toEqual([hash, hash]);
    expect(readFileSync(join(root, BLOBS_DIR, hash), 'utf8')).toBe(html);
    expect(await indexer.gcCheck([threadId], [hash])).toEqual({ [hash]: 2 });

    const bundle = join(freshDir('canvas-bundle'), 'snapshot');
    const manifest = await store.exportTo(bundle);
    expect(manifest.files.find((file) => file.path === `${BLOBS_DIR}/${hash}`)).toMatchObject({
      bytes: Buffer.byteLength(html),
      sha256: hash,
    });
    expect((await store.purge(threadId, 1)).blobsDeleted).toEqual([]);
    expect(await indexer.gcCheck([threadId], [hash])).toEqual({ [hash]: 1 });
    expect(readFileSync(join(root, BLOBS_DIR, hash), 'utf8')).toBe(html);
    expect((await store.read(threadId, 2, 1))[0]?.event).toEqual({ seq: 2, ...versions[1] });
    expect((await store.purge(threadId, 2)).blobsDeleted).toEqual([hash]);
    expect(existsSync(join(root, BLOBS_DIR, hash))).toBe(false);
    expect(await indexer.gcCheck([threadId], [hash])).toEqual({ [hash]: 0 });

    // A completed snapshot owns its copied HTML even after both source versions are purged.
    expect(readFileSync(join(bundle, BLOBS_DIR, hash), 'utf8')).toBe(html);
    const importedRoot = freshDir('canvas-import');
    StateStore.importBundle(bundle, importedRoot);
    const importedIndexer = new TruthIndexer(importedRoot);
    const imported = await StateStore.open(importedRoot, {
      indexer: importedIndexer,
      onForeignLock: () => true, // same-host copied-root confirmation
    });
    try {
      expect((await imported.read(threadId)).map((row) => row.raw)).toEqual(
        before.map((row) => row.raw)
      );
      expect(readFileSync(join(importedRoot, BLOBS_DIR, hash), 'utf8')).toBe(html);
      expect(await importedIndexer.gcCheck([threadId], [hash])).toEqual({ [hash]: 2 });
      expect((await imported.purge(threadId, 1)).blobsDeleted).toEqual([]);
      expect((await imported.purge(threadId, 2)).blobsDeleted).toEqual([hash]);
      expect(existsSync(join(importedRoot, BLOBS_DIR, hash))).toBe(false);
    } finally {
      try {
        await imported.close();
      } finally {
        importedIndexer.close();
      }
    }
  } finally {
    try {
      await store.close();
    } finally {
      indexer.close();
    }
  }
});
