/**
 * The review-traced S1-S8 sequence matrix for `foldJournalRecords` (BST-1113).
 *
 * Split out of `changeset-journal-view.test.ts` under the repo-wide 1000-line
 * cap (BST-1117), unchanged. This fold produced four consecutive review
 * escapes (R1 `added` lost on a second touch, R6 a write erasing a rename's
 * identity, R7 absorption discarding `createdInRange`, R7b absorption
 * discarding the pre-range PATH identity) — each fix corrected one field and
 * left a sibling field carrying the same class of bug. This matrix is the
 * regression net for that: every row pins the reported `path` AND `oldPath`,
 * not just the status, because asserting status alone is exactly how R7b
 * survived a green suite.
 */
import { describe, expect, it } from 'vitest';
import { foldJournalRecords } from '../../assistant-server/changeset-journal-view';
import { record } from './changeset-journal-view-test-support';

describe('foldJournalRecords — R7b full sequence matrix (review-traced S1-S8)', () => {
  // S1: delete b(pre) ; write(created a) ; rename a->b ; delete b
  // Ground truth: "deleted" at b.txt (b's own pre-range identity survives).
  it('S1: delete b(pre) ; write(created a) ; rename a->b ; delete b -> deleted at b.txt', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: true, id: 'deleteOldB', op: 'delete', path: 'b.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        op: 'rename',
        path: 'b.txt',
      }),
      record({ id: 'deleteNewB', op: 'delete', path: 'b.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('b.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('deleted');
    expect(entries[0]?.createdInRange).toBe(false);
  });

  // S2: delete b(pre) ; write(created a) ; rename a->b
  // Ground truth: "modified" at b.txt, no oldPath.
  it('S2: delete b(pre) ; write(created a) ; rename a->b -> modified at b.txt, no oldPath', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: true, id: 'deleteOldB', op: 'delete', path: 'b.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        op: 'rename',
        path: 'b.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('b.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('modified');
  });

  // S3: a created-in-range file absorbing a created-in-range occupant.
  // write(created a) ; delete a (phantom, createdInRange:true) ;
  // write(created x) ; rename x->a: absorbs the createdInRange occupant.
  // Ground truth: "added" — neither contributor pre-existed the range, so
  // the absorption must NOT surface a pre-range identity out of nowhere.
  // Correct today (before this fix); pinned here as a regression guard.
  it('S3: created-in-range file absorbing a created-in-range occupant -> added, no oldPath', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        op: 'write',
        path: 'a.txt',
      }),
      record({ id: 'deleteA', op: 'delete', path: 'a.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeX',
        op: 'write',
        path: 'x.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'x.txt',
        id: 'renameXtoA',
        op: 'rename',
        path: 'a.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('a.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('added');
    expect(entries[0]?.createdInRange).toBe(true);
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual([
      'writeA',
      'deleteA',
      'writeX',
      'renameXtoA',
    ]);
  });

  // S4: the documented NTH-2 listing collapse — delete b(pre) ;
  // rename a(pre)->b ; delete b. Ground truth: one entry, "deleted" at
  // a.txt (the module doc's own NTH-2 example). Correct today; pinned
  // here as a regression guard — "prior" (here implicit, via fromKey,
  // since a.txt was never seen before) wins over the absorbed occupant's
  // own identity, even though the occupant ALSO pre-existed.
  it('S4: delete b(pre) ; rename a(pre)->b ; delete b -> ONE entry, deleted at a.txt', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: true, id: 'deleteOldB', op: 'delete', path: 'b.txt' }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        op: 'rename',
        path: 'b.txt',
      }),
      record({ id: 'deleteNewB', op: 'delete', path: 'b.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('a.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('deleted');
    expect(entries[0]?.createdInRange).toBe(false);
  });

  // S5: S2 ; rename b->c ; write c. Ground truth: "renamed" b->c — the
  // surviving pre-range identity from S2 ("b.txt") chain-compresses
  // through the further rename, NOT the discarded "a.txt".
  it('S5: S2 ; rename b->c ; write c -> renamed b->c', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: true, id: 'deleteOldB', op: 'delete', path: 'b.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'b.txt',
        id: 'renameBtoC',
        op: 'rename',
        path: 'c.txt',
      }),
      record({ beforeExisted: true, id: 'writeC', op: 'write', path: 'c.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('c.txt');
    expect(entries[0]?.oldPath).toBe('b.txt');
    expect(entries[0]?.status).toBe('renamed');
  });

  // S6: delete c(pre) ; write(created x) ; rename x->c ; delete c ;
  // write(created y) ; rename y->c. Ground truth: ONE entry, "modified"
  // at c.txt — the second rename-into-c absorbs the (already-collapsed)
  // finished occupant sitting at c.txt, and c.txt's own pre-range
  // identity ("modified" at itself) survives both absorptions.
  it('S6: delete c(pre) ; write(created x) ; rename x->c ; delete c ; write(created y) ; rename y->c -> ONE entry, modified at c.txt', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: true, id: 'deleteOldC', op: 'delete', path: 'c.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeX',
        op: 'write',
        path: 'x.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'x.txt',
        id: 'renameXtoC',
        op: 'rename',
        path: 'c.txt',
      }),
      record({ id: 'deleteC2', op: 'delete', path: 'c.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeY',
        op: 'write',
        path: 'y.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'y.txt',
        id: 'renameYtoC',
        op: 'rename',
        path: 'c.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('c.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('modified');
    expect(entries[0]?.createdInRange).toBe(false);
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual([
      'deleteOldC',
      'writeX',
      'renameXtoC',
      'deleteC2',
      'writeY',
      'renameYtoC',
    ]);
  });

  // S7: the OTHER documented collapse case (this module's doc comment's
  // RENAME/DELETE-REKEY DESTINATION COLLISION section) — absorption via a
  // DELETE-rekey landing on an existing finished occupant, mirroring S4's
  // rename-side absorption but through foldDeleteRecord instead:
  // rename a(pre)->b ; delete a(pre, a fresh unrelated file now occupying
  // the vacated "a.txt" name) ; delete b (its rekey to "a.txt" collides
  // with, and absorbs, that finished occupant). Ground truth: ONE entry,
  // "deleted" at a.txt. Correct today (foldDeleteRecord is untouched by
  // this fix) — pinned here as a regression guard.
  it('S7: rename a(pre)->b ; delete a(pre) ; delete b -> ONE entry, deleted at a.txt', () => {
    const entries = foldJournalRecords([
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        op: 'rename',
        path: 'b.txt',
      }),
      record({ beforeExisted: true, id: 'deleteNewA', op: 'delete', path: 'a.txt' }),
      record({ id: 'deleteB', op: 'delete', path: 'b.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('a.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('deleted');
    expect(entries[0]?.createdInRange).toBe(false);
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual([
      'deleteNewA',
      'renameAtoB',
      'deleteB',
    ]);
  });

  // S8: S6 ; delete c. Ground truth: "deleted" at c.txt — one absorption
  // level deeper than R7 (S8 IS the R7 defect, re-encountered after a
  // second round of collapse-then-recreate). Before this fix, the second
  // delete re-keyed off "c.txt" (S6's buggy path was "x.txt"), found NO
  // occupant on the LATER rename, and `mergeCreatedInRange` returned
  // `true` — silently dropping a genuinely-vanished pre-existing file.
  it('S8: S6 ; delete c -> deleted at c.txt, survives the phantom filter', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: true, id: 'deleteOldC', op: 'delete', path: 'c.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeX',
        op: 'write',
        path: 'x.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'x.txt',
        id: 'renameXtoC',
        op: 'rename',
        path: 'c.txt',
      }),
      record({ id: 'deleteC2', op: 'delete', path: 'c.txt' }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeY',
        op: 'write',
        path: 'y.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'y.txt',
        id: 'renameYtoC',
        op: 'rename',
        path: 'c.txt',
      }),
      record({ id: 'deleteC3', op: 'delete', path: 'c.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('c.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('deleted');
    expect(entries[0]?.createdInRange).toBe(false);
  });
});
