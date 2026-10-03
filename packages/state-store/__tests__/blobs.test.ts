// The blob store (M0-A2 src/host.ts toBody/putBlob): text of 12 KB or more is stored once, content-addressed, with a
// preview kept inline; the blob is durable before the event that references it is appended.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  BLOB_MIN_BYTES,
  BLOBS_DIR,
  largeText,
  PREVIEW_CHARS,
  StateStore,
  sha256Hex,
} from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { appendInputs, prose, rng } from './helpers/testkit.js';

afterEach(() => cleanupDirs());

describe('blob store', () => {
  test('12 KB or more becomes a content-addressed blob with an inline preview; less stays inline', async () => {
    const root = freshDir('blob');
    const store = await StateStore.open(root);
    try {
      const big = prose(rng(1), BLOB_MIN_BYTES);
      const small = prose(rng(2), BLOB_MIN_BYTES - 1);
      await appendInputs(store, 't1', [
        { output: big, type: 'tool-result' },
        { output: small, type: 'tool-result' },
        { output: big, type: 'tool-result' },
      ]);
      const [a, b, c] = (await store.read('t1')).map(
        (r) => JSON.parse(r.raw) as Record<string, unknown>
      );
      expect(a).toMatchObject({
        blob: sha256Hex(big),
        bytes: BLOB_MIN_BYTES,
        preview: big.slice(0, PREVIEW_CHARS),
      });
      expect(a).not.toHaveProperty('output');
      expect(b).toMatchObject({ output: small });
      expect(b).not.toHaveProperty('blob');
      expect(c?.['blob']).toBe(a?.['blob']); // stored once
      expect(readFileSync(join(root, BLOBS_DIR, sha256Hex(big)), 'utf8')).toBe(big);
      expect(largeText(small).blob).toBeNull();
    } finally {
      await store.close();
    }
  });

  test('a blob hash must match its content; an existing corrupt blob never commits a reference', async () => {
    const root = freshDir('blob-integrity');
    const store = await StateStore.open(root);
    try {
      const content = 'expected';
      const hash = sha256Hex(content);
      await expect(
        store.append([
          {
            blobs: [{ content: 'different', hash }],
            event: { blob: hash, type: 'tool-result' },
            threadId: 't',
          },
        ])
      ).rejects.toThrow(/hash|checksum/);
      expect(await store.read('t')).toEqual([]);
      writeFileSync(join(root, BLOBS_DIR, hash), 'corrupt');
      await expect(
        store.append([
          { blobs: [{ content, hash }], event: { blob: hash, type: 'tool-result' }, threadId: 't' },
        ])
      ).rejects.toThrow(/hash|checksum/);
      expect(await store.read('t')).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test('an event cannot commit a reference to a missing blob', async () => {
    const store = await StateStore.open(freshDir('blob-missing'));
    try {
      await expect(
        store.append([
          { event: { blob: sha256Hex('missing'), type: 'tool-result' }, threadId: 't' },
        ])
      ).rejects.toThrow(/missing blob/);
    } finally {
      await expect(store.close()).rejects.toThrow(/failed earlier/);
    }
  });

  test('a blob that cannot be written appends nothing: the blob is durable before its event', async () => {
    const root = freshDir('blobfail');
    const store = await StateStore.open(root);
    try {
      await appendInputs(store, 't1', [{ content: 'before', type: 'text' }]);
      const blobs = join(root, BLOBS_DIR);
      rmSync(blobs, { recursive: true });
      writeFileSync(blobs, 'not a directory'); // every blob write now fails
      await expect(
        appendInputs(store, 't1', [{ output: prose(rng(3), BLOB_MIN_BYTES), type: 'tool-result' }])
      ).rejects.toThrow();
      expect((await store.read('t1')).map((r) => r.seq)).toEqual([1]);
      expect(existsSync(blobs)).toBe(true);
    } finally {
      await store.close();
    }
  });
});
