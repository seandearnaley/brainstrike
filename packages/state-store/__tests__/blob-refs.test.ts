// An event may reference content-addressed blobs it does not spool (`blobRefs`), e.g. a host's
// first-touch file baselines. The references share the `blob` field's whole lifecycle: durable
// before the event commits, counted by the indexer, exported, and collected with their thread.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { blobsOf } from '../src/run-log-format.mjs';
import { BLOBS_DIR, StateStore, sha256Hex } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(() => cleanupDirs());

const baseline = (text: string) => ({ content: text, hash: sha256Hex(text) });

test('blobsOf lists the spooled blob and every referenced blob once', () => {
  const a = sha256Hex('a');
  const b = sha256Hex('b');
  expect(blobsOf(JSON.stringify({ blobRefs: [a, b, a], type: 'edit' }))).toEqual([a, b]);
  expect(blobsOf(JSON.stringify({ blob: a, blobRefs: [b], type: 'edit' }))).toEqual([a, b]);
  expect(() => blobsOf(JSON.stringify({ blobRefs: ['nope'], type: 'edit' }))).toThrow(
    /invalid blob hash/
  );
  expect(() => blobsOf(JSON.stringify({ blobRefs: 'nope', type: 'edit' }))).toThrow(
    /invalid blob hash/
  );
});

test('an event cannot commit a reference to a missing blob', async () => {
  const store = await StateStore.open(freshDir('blob-refs-missing'));
  try {
    await expect(
      store.append([{ event: { blobRefs: [sha256Hex('absent')], type: 'edit' }, threadId: 't' }])
    ).rejects.toThrow(/missing blob/);
  } finally {
    // As for a spooled `blob`, a refused reference fails the writer (blobs.test.ts).
    await expect(store.close()).rejects.toThrow(/failed earlier/);
  }
});

test('thread delete collects its referenced blobs; a blob another thread references survives', async () => {
  const root = freshDir('blob-refs-delete');
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer });
  try {
    const own = baseline('only the deleted thread keeps this baseline');
    const shared = baseline('both threads keep this baseline');
    await store.append([
      {
        blobs: [own, shared],
        event: { blobRefs: [own.hash, shared.hash], type: 'edit' },
        threadId: 'a',
      },
      { blobs: [shared], event: { blobRefs: [shared.hash], type: 'edit' }, threadId: 'b' },
    ]);
    expect(readFileSync(join(root, BLOBS_DIR, own.hash), 'utf8')).toBe(own.content);
    expect(await indexer.gcCheck(['a', 'b'], [own.hash, shared.hash])).toEqual({
      [own.hash]: 1,
      [shared.hash]: 2,
    });

    expect(await store.deleteThread('a')).toEqual([own.hash]);
    expect(existsSync(join(root, BLOBS_DIR, own.hash))).toBe(false);
    expect(readFileSync(join(root, BLOBS_DIR, shared.hash), 'utf8')).toBe(shared.content);

    expect(await store.deleteThread('b')).toEqual([shared.hash]);
    expect(existsSync(join(root, BLOBS_DIR, shared.hash))).toBe(false);
  } finally {
    try {
      await store.close();
    } finally {
      indexer.close();
    }
  }
});
