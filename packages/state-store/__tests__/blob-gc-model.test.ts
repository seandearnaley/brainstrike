// ADR-0011: a blob is removed only when no row names it, verified or damaged, and once nothing holds collection every
// blob on disk is named by some row. The model, its commands and the driver are in helpers/blob-gc-model.ts; this file
// runs part 1 of 4 of the generated histories and the two product bugs the model found.
import { afterEach, expect, test } from 'vitest';
import {
  blobsOnDisk,
  checkGeneratedHistories,
  damageRow,
  editOf,
  Real,
  toolResultOf,
} from './helpers/blob-gc-model.ts';
import { cleanupDirs, freshDir } from './helpers/fs.ts';

afterEach(() => cleanupDirs());

test('no named blob is ever removed, and nothing is left unnamed once collection is free (part 1 of 4)', async () => {
  await checkGeneratedHistories();
});

// BST-2458 product bug, found by the generated histories when a crash may follow a hold: the hold's deferred
// hashes live only in memory (StateDeletion #deferred), and the purge or delete drops its intent as soon as it defers.
// A close or crash before the release loses them, and nothing collects the blob afterwards. The host holds collection
// for a whole session whenever hydration found a damaged thread (thread-catalog.ts), so every purge in such a session
// leaves its blob on disk for good, though the purge promises no byte of the event is left in the blobs.
test.fails('a purge made while collection is held still collects its blob after a restart', async () => {
  const real = new Real(freshDir('blob-gc-held-restart'));
  await real.open();
  try {
    await real.store.append([{ ...toolResultOf(0), threadId: 'a' }]);
    real.releases.push(real.store.holdBlobGc());
    await real.store.purge('a', 1);
    await real.crash();
    await real.reopen();
    expect(blobsOnDisk(real.root)).toEqual([]);
  } finally {
    await real.dispose();
  }
});

// BST-2458 product bug, the same leak by another path: an append spools its blobs before the row commits, so a refused append, here to a
// damaged thread, leaves blobs no row names, and nothing collects them later. A crash between the blob write and the
// commit leaves the same orphan.
test.fails('an append the store refuses leaves no blob behind', async () => {
  const real = new Real(freshDir('blob-gc-refused-append'));
  await real.open();
  try {
    await real.store.append([{ event: { type: 'note' }, threadId: 'a' }]);
    await real.crash();
    damageRow(real.root, 'a', 1, true);
    await real.reopen();
    await expect(real.store.append([{ ...editOf([0]), threadId: 'a' }])).rejects.toThrow(
      /damaged|read-only/u
    );
    expect(blobsOnDisk(real.root)).toEqual([]);
  } finally {
    await real.dispose();
  }
});
