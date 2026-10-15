/**
 * Real-PGlite coverage for the workspace-snapshot ledger repository
 * (BST-1164, W7 T1). Runs the FULL production migration chain (house pattern
 * of the rewind fixtures) so the table under test is exactly what migration
 * 081 creates — CHECK constraint, indexes, and all.
 */

import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSnapshotRepository,
  generateWorkspaceSnapshotId,
  type SnapshotRepository,
} from '../../assistant-server/snapshot-repository';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);
const OID_D = 'd'.repeat(40);

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: PGlite;
let repository: SnapshotRepository;

beforeEach(async () => {
  db = await createMigratedTestDb();
  repository = createSnapshotRepository(db);
});

afterEach(async () => {
  await db.close();
});

describe('generateWorkspaceSnapshotId', () => {
  it('mints RFC 9562 uuidv7 ids whose time prefix sorts by timestamp', () => {
    const earlier = generateWorkspaceSnapshotId(1_000_000);
    const later = generateWorkspaceSnapshotId(2_000_000);
    expect(earlier).toMatch(UUID_V7_PATTERN);
    expect(later).toMatch(UUID_V7_PATTERN);
    expect(earlier < later).toBe(true);
    expect(generateWorkspaceSnapshotId()).not.toBe(generateWorkspaceSnapshotId());
  });

  it('mints strictly increasing ids within one millisecond (RFC 9562 monotonic counter)', () => {
    const ms = Date.now();
    const ids = [
      generateWorkspaceSnapshotId(ms),
      generateWorkspaceSnapshotId(ms),
      generateWorkspaceSnapshotId(ms),
    ];
    // Two DB rows can tie on `created_at` (PGlite stamps consecutive inserts
    // in the same millisecond), so the id tiebreak in `ORDER BY created_at,
    // id` must encode mint order — random rand_a would make it a coin flip.
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it('refuses an unencodable timestamp instead of truncating it', () => {
    expect(() => generateWorkspaceSnapshotId(2 ** 48)).toThrow(RangeError);
    expect(() => generateWorkspaceSnapshotId(-1)).toThrow(RangeError);
  });
});

describe('insertSnapshot', () => {
  it('returns the full stored row with a minted uuidv7 id and DB-stamped createdAt', async () => {
    const row = await repository.insertSnapshot({
      commitOid: OID_A,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a',
      runId: 'run-1',
      threadId: 'thread-1',
    });

    expect(row.id).toMatch(UUID_V7_PATTERN);
    expect(row.commitOid).toBe(OID_A);
    expect(row.kind).toBe('turn-start');
    expect(row.rootId).toBe('root-a');
    expect(row.rootPath).toBe('/w/a');
    expect(row.runId).toBe('run-1');
    expect(row.threadId).toBe('thread-1');
    // Full-precision text timestamp, never a JS Date.
    expect(typeof row.createdAt).toBe('string');
    expect(row.createdAt.length).toBeGreaterThan(0);

    const stored = await repository.snapshotsForThread('thread-1');
    expect(stored).toEqual([row]);
  });

  it('stores an omitted runId as NULL (a turn is not a run)', async () => {
    const row = await repository.insertSnapshot({
      commitOid: OID_A,
      kind: 'turn-end',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    expect(row.runId).toBeNull();
  });

  it('refuses a malformed commit oid before touching the database', async () => {
    await expect(
      repository.insertSnapshot({
        commitOid: 'not-an-oid',
        kind: 'turn-start',
        rootId: 'root-a',
        rootPath: '/w/a',
        threadId: 'thread-1',
      })
    ).rejects.toThrow(/insertSnapshot "commitOid"/);
    expect(await repository.snapshotsForThread('thread-1')).toEqual([]);
  });
});

describe('snapshotsForThread', () => {
  it('lists only the thread, oldest first', async () => {
    const first = await repository.insertSnapshot({
      commitOid: OID_A,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    const second = await repository.insertSnapshot({
      commitOid: OID_B,
      kind: 'turn-end',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    await repository.insertSnapshot({
      commitOid: OID_C,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-other',
    });

    const rows = await repository.snapshotsForThread('thread-1');
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });
});

describe('latestSnapshotFor', () => {
  it('resolves the newest row per (thread, root), optionally filtered by kind', async () => {
    await repository.insertSnapshot({
      commitOid: OID_A,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    const laterStart = await repository.insertSnapshot({
      commitOid: OID_B,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    const end = await repository.insertSnapshot({
      commitOid: OID_C,
      kind: 'turn-end',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    // Same thread, DIFFERENT root — must never leak into root-a resolution.
    await repository.insertSnapshot({
      commitOid: OID_D,
      kind: 'turn-end',
      rootId: 'root-b',
      rootPath: '/w/b',
      threadId: 'thread-1',
    });

    const latest = await repository.latestSnapshotFor('thread-1', 'root-a');
    expect(latest?.id).toBe(end.id);
    const latestStart = await repository.latestSnapshotFor('thread-1', 'root-a', 'turn-start');
    expect(latestStart?.id).toBe(laterStart.id);
    expect(await repository.latestSnapshotFor('thread-1', 'root-a', 'pre-revert')).toBeNull();
    expect(await repository.latestSnapshotFor('thread-missing', 'root-a')).toBeNull();
  });
});

describe('rootsForThread', () => {
  it('lists each root once with its most recently recorded path', async () => {
    await repository.insertSnapshot({
      commitOid: OID_A,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a-old',
      threadId: 'thread-1',
    });
    await repository.insertSnapshot({
      commitOid: OID_B,
      kind: 'turn-end',
      rootId: 'root-a',
      rootPath: '/w/a-moved',
      threadId: 'thread-1',
    });
    await repository.insertSnapshot({
      commitOid: OID_C,
      kind: 'turn-start',
      rootId: 'root-b',
      rootPath: '/w/b',
      threadId: 'thread-1',
    });
    await repository.insertSnapshot({
      commitOid: OID_D,
      kind: 'turn-start',
      rootId: 'root-c',
      rootPath: '/w/c',
      threadId: 'thread-other',
    });

    expect(await repository.rootsForThread('thread-1')).toEqual([
      { rootId: 'root-a', rootPath: '/w/a-moved' },
      { rootId: 'root-b', rootPath: '/w/b' },
    ]);
  });
});

describe('deleteForThread', () => {
  it('deletes only the thread and returns the deleted commit oids grouped per root', async () => {
    await repository.insertSnapshot({
      commitOid: OID_A,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    await repository.insertSnapshot({
      commitOid: OID_B,
      kind: 'turn-end',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-1',
    });
    await repository.insertSnapshot({
      commitOid: OID_C,
      kind: 'turn-end',
      rootId: 'root-b',
      rootPath: '/w/b',
      threadId: 'thread-1',
    });
    const survivor = await repository.insertSnapshot({
      commitOid: OID_D,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/w/a',
      threadId: 'thread-survivor',
    });

    const deleted = await repository.deleteForThread('thread-1');
    expect(deleted).toEqual([
      { commitOids: [OID_A, OID_B], rootId: 'root-a' },
      { commitOids: [OID_C], rootId: 'root-b' },
    ]);

    expect(await repository.snapshotsForThread('thread-1')).toEqual([]);
    expect(await repository.snapshotsForThread('thread-survivor')).toEqual([survivor]);
    // Idempotent: a second delete has nothing to report.
    expect(await repository.deleteForThread('thread-1')).toEqual([]);
  });
});

describe('closed kind vocabulary', () => {
  it('throws on read when a stored kind falls outside the union (never a silent skip)', async () => {
    // The migration-081 CHECK makes this state impossible for rows this
    // repository wrote; simulate schema/code drift by dropping the constraint.
    await db.exec(
      'ALTER TABLE brainstrike_workspace_snapshots DROP CONSTRAINT brainstrike_workspace_snapshots_kind_check'
    );
    await db.query(
      `INSERT INTO brainstrike_workspace_snapshots
         (id, thread_id, root_id, root_path, commit_oid, kind)
       VALUES ('drifted', 'thread-1', 'root-a', '/w/a', $1, 'mid-turn')`,
      [OID_A]
    );

    await expect(repository.snapshotsForThread('thread-1')).rejects.toThrow(
      /unknown kind "mid-turn"/
    );
    await expect(repository.latestSnapshotFor('thread-1', 'root-a')).rejects.toThrow(
      /unknown kind "mid-turn"/
    );
  });
});
