/**
 * Fake-db unit coverage for the journal-sourced `ChangesetDiffService` half
 * (BST-1113): the per-path fold (latest-wins, rename keying, revertible), and
 * `fileDiff`'s old/new side assembly. Real end-to-end behavior against a real
 * PGlite `brainstrike_assistant_edit_checkpoints` table is exercised at the
 * journal-repository level by `edit-checkpoint-journal.integration.test.ts` —
 * this file fakes the DB entirely so the fold logic itself is falsifiable
 * without any I/O.
 *
 * The review-traced S1-S8 sequence matrix lives in the sibling
 * `changeset-journal-view-matrix.test.ts`; shared fixtures in
 * `changeset-journal-view-test-support.ts`.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  foldJournalRecords,
  journalFoldEntryToChangedFileEntry,
  resolveJournalChangesetView,
  resolveJournalFileDiff,
} from '../../assistant-server/changeset-journal-view';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import { cleanupTempDirs, makeTempDir, record } from './changeset-journal-view-test-support';

afterEach(cleanupTempDirs);

describe('foldJournalRecords — status classification', () => {
  it('a single write with beforeExisted:false is "added"', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: false, captureStatus: 'created' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('added');
    expect(entries[0]?.oldPath).toBeNull();
  });

  it('a single write with beforeExisted:true is "modified"', () => {
    const entries = foldJournalRecords([record({ beforeExisted: true })]);
    expect(entries[0]?.status).toBe('modified');
  });

  it('two writes to the same path: "added" PERSISTS from the FIRST record even though the SECOND record is itself a modification', () => {
    // R1 (review finding): the plan's contract is `added` iff `beforeExisted`
    // is false on the FIRST record for the path — that must survive a later
    // touch, not collapse to `modified` just because a second record exists.
    const entries = foldJournalRecords([
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'r1',
        occurredAt: '2026-01-01T00:00:01.000Z',
      }),
      record({ beforeExisted: true, id: 'r2', occurredAt: '2026-01-01T00:00:02.000Z' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('added');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('a delete op is "deleted", oldPath cleared', () => {
    const entries = foldJournalRecords([record({ op: 'delete' })]);
    expect(entries[0]?.status).toBe('deleted');
    expect(entries[0]?.oldPath).toBeNull();
  });

  it('a rename of a path never seen before reports "renamed" with oldPath = fromPath', () => {
    const entries = foldJournalRecords([
      record({ captureStatus: 'rename', fromPath: 'old.txt', op: 'rename', path: 'new.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('new.txt');
    expect(entries[0]?.status).toBe('renamed');
    expect(entries[0]?.oldPath).toBe('old.txt');
  });

  it('write A -> rename A->B -> write B: exactly ONE final entry, no contradictory statuses', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'w1',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'ren',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        beforeExisted: true,
        id: 'w2',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'write',
        path: 'b.txt',
      }),
    ]);
    // Exactly one entry, at the FINAL path only.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('b.txt');
    // Created-then-renamed-then-written-again carries no external "before"
    // identity at ANY point in the chain — `added` persists (R1).
    expect(entries[0]?.status).toBe('added');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual(['w1', 'ren', 'w2']);
  });

  it('a multi-hop rename (A->B->C) in one changeset chain-compresses oldPath to the ORIGINAL pre-range path', () => {
    const entries = foldJournalRecords([
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'r1',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'b.txt',
        id: 'r2',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'rename',
        path: 'c.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('c.txt');
    expect(entries[0]?.status).toBe('renamed');
    expect(entries[0]?.oldPath).toBe('a.txt');
  });

  it('rename a->b then delete b (R4): reports the ORIGINAL path "a.txt" as deleted, not "b.txt"', () => {
    // From outside the changeset, "b.txt" never existed — only its
    // predecessor "a.txt" did, and it was deleted.
    const entries = foldJournalRecords([
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'ren',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        id: 'del',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('a.txt');
    expect(entries[0]?.status).toBe('deleted');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual(['ren', 'del']);
  });

  it('a delete with NO rename in its history stays keyed at record.path (unaffected by R4)', () => {
    const entries = foldJournalRecords([
      record({ beforeExisted: true, id: 'del', op: 'delete', path: 'plain.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('plain.txt');
    expect(entries[0]?.status).toBe('deleted');
  });
});

describe('foldJournalRecords — R6: a write between rename hops must not erase the rename identity', () => {
  it('rename a->b ; write b: stays "renamed" with oldPath "a.txt" (the write must not reset it to "modified")', () => {
    const entries = foldJournalRecords([
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'ren',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        beforeExisted: true,
        id: 'write',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'b.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('b.txt');
    expect(entries[0]?.status).toBe('renamed');
    expect(entries[0]?.oldPath).toBe('a.txt');
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual(['ren', 'write']);
  });

  it('rename a->b ; write b ; delete b: R4 still fires — reports "a.txt" deleted, not "b.txt"', () => {
    const entries = foldJournalRecords([
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'ren',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        beforeExisted: true,
        id: 'write',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'b.txt',
      }),
      record({
        id: 'del',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('a.txt');
    expect(entries[0]?.status).toBe('deleted');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual(['ren', 'write', 'del']);
  });

  it('rename a->b ; write b ; rename b->c: chain compression still fires — oldPath is "a.txt", not "b.txt"', () => {
    const entries = foldJournalRecords([
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'ren1',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        beforeExisted: true,
        id: 'write',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'b.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'b.txt',
        id: 'ren2',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'rename',
        path: 'c.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('c.txt');
    expect(entries[0]?.status).toBe('renamed');
    expect(entries[0]?.oldPath).toBe('a.txt');
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual(['ren1', 'write', 'ren2']);
  });
});

describe('foldJournalRecords — rejected identity collisions (R2)', () => {
  it('throws when a rename destination already has a DIFFERENT live tracked history', () => {
    // Without the guard, this would silently drop the "b.txt" write's
    // chainRecords, corrupting `revertible` for the surviving entry.
    const records = [
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeB',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'write',
        path: 'b.txt',
      }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
    ];
    expect(() => foldJournalRecords(records)).toThrow(/^journal-path-collision:/);
  });

  it('throws when a delete-rekey (R4) destination already has a DIFFERENT live tracked history', () => {
    // B (pre-existing, external) is renamed away to X. Separately, a BRAND
    // NEW file is created at the now-free path "B". Deleting X re-keys (R4)
    // back to its original identity "B" — which collides with the live,
    // unrelated "B" created afterward.
    const records = [
      record({
        captureStatus: 'rename',
        fromPath: 'b.txt',
        id: 'renameBtoX',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'rename',
        path: 'x.txt',
      }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeNewB',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'b.txt',
      }),
      record({
        id: 'deleteX',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'delete',
        path: 'x.txt',
      }),
    ];
    expect(() => foldJournalRecords(records)).toThrow(/^journal-path-collision:/);
  });
});

describe('foldJournalRecords — finished-delete absorption (NTH-3)', () => {
  it('delete b ; rename a->b does NOT throw — the finished "deleted b" history is absorbed, not treated as a collision', () => {
    // An ordinary "remove the old file, move the new one into place" shape.
    const entries = foldJournalRecords([
      record({
        beforeExisted: true,
        id: 'deleteB',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('b.txt');
    expect(entries[0]?.status).toBe('renamed');
    expect(entries[0]?.oldPath).toBe('a.txt');
    // The finished "deleted b" record is absorbed as a chronological
    // prefix — it can only make `revertible` more conservative.
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual(['deleteB', 'renameAtoB']);
  });

  it('a still-unfinished (non-deleted) occupant is a genuine collision, not absorbed', () => {
    // Sanity check that absorption is SPECIFIC to a `deleted` occupant —
    // this is the same collision as the "rename destination" test above,
    // re-asserted here to pin the boundary of the absorption rule.
    const records = [
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeB',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'write',
        path: 'b.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
    ];
    expect(() => foldJournalRecords(records)).toThrow(/^journal-path-collision:/);
  });
});

describe('foldJournalRecords — R7: absorbing a PRE-EXISTING occupant must not mark the merged entry createdInRange', () => {
  it('delete b (pre-existing) ; write(created a) ; rename a->b: NOT "added" — the absorbed occupant pre-existed', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: true,
        id: 'deleteOldB',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.createdInRange).toBe(false);
    // NEVER "added" for a path whose journal holds a pre-existing deletion.
    expect(entries[0]?.status).not.toBe('added');
    // R7b (review finding): the occupant "b.txt" is the pre-range identity
    // that survives here — "a.txt" was itself createdInRange, so it
    // contributes nothing pre-range. Reported at "b.txt", status
    // "modified" (identity equals the rename's own destination — no NET
    // rename relative to the surviving identity), no oldPath.
    expect(entries[0]?.path).toBe('b.txt');
    expect(entries[0]?.oldPath).toBeNull();
    expect(entries[0]?.status).toBe('modified');
    expect(entries[0]?.chainRecords.map((r) => r.id)).toEqual([
      'deleteOldB',
      'writeA',
      'renameAtoB',
    ]);
  });

  it('delete b (pre-existing) ; write(created a) ; rename a->b ; delete b: the view is NOT empty — b genuinely changed', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: true,
        id: 'deleteOldB',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        id: 'deleteNewB',
        occurredAt: '2026-01-01T00:00:04.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) {
      throw new Error('expected one fold entry');
    }
    // The pre-existing "b" genuinely changed (it is gone) — this must NEVER
    // be treated as a phantom (createdInRange:true) and dropped.
    expect(entry.createdInRange).toBe(false);
    expect(entry.status).toBe('deleted');
    // R7b (review finding): reported at "b.txt" — its OWN pre-range
    // identity, not "a.txt" (which never existed outside this changeset).
    expect(entry.path).toBe('b.txt');
    expect(entry.oldPath).toBeNull();
    expect(entry.chainRecords.map((r) => r.id)).toEqual([
      'deleteOldB',
      'writeA',
      'renameAtoB',
      'deleteNewB',
    ]);
    // The resolveJournalChangesetView-level test below confirms this
    // entry actually survives the isPhantomEntry filter.
  });
});

describe('foldJournalRecords — phantom entries (NTH-4): created AND deleted entirely within the range', () => {
  it('write(created a) ; delete a: the fold still has an entry (raw fold is complete)', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'write',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({ id: 'del', occurredAt: '2026-01-01T00:00:02.000Z', op: 'delete', path: 'a.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.createdInRange).toBe(true);
    expect(entries[0]?.status).toBe('deleted');
  });

  it('created ; renamed ; deleted (all within range) is ALSO a phantom, at whatever key it lands on', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'write',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'ren',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({ id: 'del', occurredAt: '2026-01-01T00:00:03.000Z', op: 'delete', path: 'b.txt' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.createdInRange).toBe(true);
    expect(entries[0]?.status).toBe('deleted');
  });
});

describe('foldJournalRecords — revertible', () => {
  it('true when every record is revertible and unreverted', () => {
    const entries = foldJournalRecords([record({ captureStatus: 'ok' })]);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) {
      throw new Error('expected one fold entry');
    }
    expect(journalFoldEntryToChangedFileEntry(entry).revertible).toBe(true);
  });

  it('false when ANY record in the chain has a non-revertible captureStatus (expired) — entry still present', () => {
    const entries = foldJournalRecords([
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'r1',
        occurredAt: '2026-01-01T00:00:01.000Z',
      }),
      record({ captureStatus: 'expired', id: 'r2', occurredAt: '2026-01-01T00:00:02.000Z' }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) {
      throw new Error('expected one fold entry');
    }
    // Still present — an expired record is NEVER treated as no-change. Status
    // stays "added" (R1: the FIRST record's beforeExisted:false persists).
    expect(entry.status).toBe('added');
    expect(journalFoldEntryToChangedFileEntry(entry).revertible).toBe(false);
  });

  it('false when any record in the chain is already reverted', () => {
    const entries = foldJournalRecords([
      record({
        captureStatus: 'ok',
        id: 'r1',
        occurredAt: '2026-01-01T00:00:01.000Z',
        revertedAt: '2026-01-01T00:00:05.000Z',
      }),
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) {
      throw new Error('expected one fold entry');
    }
    expect(journalFoldEntryToChangedFileEntry(entry).revertible).toBe(false);
  });
});

describe('resolveJournalChangesetView', () => {
  function fakeDb(records: AssistantEditCheckpointRecord[]): EditCheckpointDatabase {
    return {
      query: (async (sql: string) => {
        if (sql.includes('brainstrike_assistant_edit_checkpoints') && sql.includes('run_id = $1')) {
          return { rows: records };
        }
        throw new Error(`unexpected query in fake db: ${sql}`);
      }) as EditCheckpointDatabase['query'],
    };
  }

  it('revertible is false for an entry whose first record has an expired capture; additions/deletions are null', async () => {
    const db = fakeDb([record({ captureStatus: 'expired' })]);
    const result = await resolveJournalChangesetView(db, {
      kind: 'agent-run',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.revertible).toBe(false);
    expect(result.value.files[0]?.additions).toBeNull();
    expect(result.value.files[0]?.deletions).toBeNull();
    expect(result.value.totalAdditions).toBeNull();
    expect(result.value.totalDeletions).toBeNull();
  });

  it('a path created AND deleted entirely within the changeset is DROPPED from the view (NTH-4)', async () => {
    const db = fakeDb([
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'write',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({ id: 'del', occurredAt: '2026-01-01T00:00:02.000Z', op: 'delete', path: 'a.txt' }),
    ]);
    const result = await resolveJournalChangesetView(db, {
      kind: 'agent-run',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files).toEqual([]);
  });

  it('R7: a genuinely pre-existing path (delete b ; write(created a) ; rename a->b ; delete b) survives the view, NOT dropped as a phantom', async () => {
    const db = fakeDb([
      record({
        beforeExisted: true,
        id: 'deleteOldB',
        occurredAt: '2026-01-01T00:00:01.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
      record({
        beforeExisted: false,
        captureStatus: 'created',
        id: 'writeA',
        occurredAt: '2026-01-01T00:00:02.000Z',
        op: 'write',
        path: 'a.txt',
      }),
      record({
        captureStatus: 'rename',
        fromPath: 'a.txt',
        id: 'renameAtoB',
        occurredAt: '2026-01-01T00:00:03.000Z',
        op: 'rename',
        path: 'b.txt',
      }),
      record({
        id: 'deleteNewB',
        occurredAt: '2026-01-01T00:00:04.000Z',
        op: 'delete',
        path: 'b.txt',
      }),
    ]);
    const result = await resolveJournalChangesetView(db, {
      kind: 'agent-run',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The bug reported an EMPTY view ("no changes at all") — the fix must
    // surface SOMETHING, since a real pre-existing file genuinely vanished.
    expect(result.value.files).toHaveLength(1);
    // R7b (review finding): reported at "b.txt" — its OWN pre-range
    // identity, not the discarded "a.txt" (S1 in the review's sequence
    // matrix).
    expect(result.value.files[0]?.path).toBe('b.txt');
    expect(result.value.files[0]?.oldPath).toBeUndefined();
    expect(result.value.files[0]?.status).toBe('deleted');
  });

  it('an empty run range yields an empty view, not an error', async () => {
    const db = fakeDb([]);
    const result = await resolveJournalChangesetView(db, {
      kind: 'agent-run',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files).toEqual([]);
  });

  it('propagates a run-range GitResult error verbatim (runs-unavailable prefix intact)', async () => {
    // `listRunRangeCheckpoints` itself is exercised at the journal-repository
    // level; here we only confirm resolveJournalChangesetView routes a
    // run-range changeset through it and propagates a failing GitResult —
    // simulated via a db whose `to_regclass` probe reports the runs table absent.
    const probingDb: EditCheckpointDatabase = {
      query: (async (sql: string) => {
        if (sql.includes('to_regclass')) {
          return { rows: [{ present: false }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }) as EditCheckpointDatabase['query'],
    };
    const result = await resolveJournalChangesetView(probingDb, {
      fromRunId: 'run-1',
      kind: 'run-range',
      threadId: 'thread-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^runs-unavailable:/);
  });
});

describe('resolveJournalFileDiff', () => {
  function fakeDbWithBeforeContent(
    records: AssistantEditCheckpointRecord[],
    beforeContentById: Record<string, { beforeContent: string | null; beforeExisted: boolean }>
  ): EditCheckpointDatabase {
    return {
      query: (async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes('run_id = $1')) {
          return { rows: records };
        }
        if (sql.includes('before_content')) {
          const id = String((params ?? [])[0]);
          const row = beforeContentById[id];
          if (!row) {
            return { rows: [] };
          }
          return { rows: [row] };
        }
        throw new Error(`unexpected query in fake db: ${sql}`);
      }) as EditCheckpointDatabase['query'],
    };
  }

  it('returns "journal-content-expired:" when the first unreverted record has beforeExisted:true but no stored before_content', async () => {
    const rec = record({ beforeExisted: true, captureStatus: 'expired', id: 'expired-1' });
    const db = fakeDbWithBeforeContent([rec], {
      'expired-1': { beforeContent: null, beforeExisted: true },
    });
    const result = await resolveJournalFileDiff(
      { db, resolveRootCwd: async () => ({ error: 'should not be called', ok: false }) },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      'a.txt'
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^journal-content-expired:/);
  });

  it('an added entry (beforeExisted:false on the first record) has oldContent:null — never an error', async () => {
    const rootDir = await makeTempDir();
    await fsPromises.writeFile(path.join(rootDir, 'a.txt'), 'current content\n', 'utf8');
    const rec = record({ beforeExisted: false, captureStatus: 'created', id: 'added-1' });
    const db = fakeDbWithBeforeContent([rec], {});
    const result = await resolveJournalFileDiff(
      { db, resolveRootCwd: async () => ({ ok: true, value: rootDir }) },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      'a.txt'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'current content\n',
      oldContent: null,
    });
  });

  it('a deleted entry has newContent:null (never a disk read, never an error) with the captured oldContent', async () => {
    const rec = record({
      beforeContent: 'gone content\n',
      captureStatus: 'ok',
      id: 'del-1',
      op: 'delete',
    });
    const db = fakeDbWithBeforeContent([rec], {
      'del-1': { beforeContent: 'gone content\n', beforeExisted: true },
    });
    const result = await resolveJournalFileDiff(
      {
        db,
        resolveRootCwd: async () => ({
          error: 'should not be called for a deleted entry',
          ok: false,
        }),
      },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      'a.txt'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('deleted');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: null,
      oldContent: 'gone content\n',
    });
  });

  it('no journaled change for the requested path is a typed error', async () => {
    const db = fakeDbWithBeforeContent([record({ path: 'other.txt' })], {});
    const result = await resolveJournalFileDiff(
      { db, resolveRootCwd: async () => ({ error: 'unused', ok: false }) },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      'a.txt'
    );
    expect(result.ok).toBe(false);
  });

  it('a phantom entry (created AND deleted within range) is "not found", NOT resolved as a real deleted-file diff (NTH-1)', async () => {
    const db = fakeDbWithBeforeContent(
      [
        record({
          beforeExisted: false,
          captureStatus: 'created',
          id: 'write',
          occurredAt: '2026-01-01T00:00:01.000Z',
          op: 'write',
          path: 'a.txt',
        }),
        record({
          id: 'del',
          occurredAt: '2026-01-01T00:00:02.000Z',
          op: 'delete',
          path: 'a.txt',
        }),
      ],
      {}
    );
    const result = await resolveJournalFileDiff(
      {
        db,
        resolveRootCwd: async () => {
          throw new Error('resolveRootCwd must never be reached for a phantom (dropped) entry');
        },
      },
      { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
      'a.txt'
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('no journaled change for path');
  });
});
