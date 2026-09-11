/**
 * Attribution-ledger repository — record + list + retention against REAL
 * PGlite. Since BST-1164 T4 the ledger stores identity only (op, paths,
 * hashes, timestamps): `before_content` is NEVER populated (pinned below),
 * the byte-budget/`expired` retention died with content capture, and the
 * row cap is the whole retention policy.
 */

import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EditCheckpointDatabase,
  type EditCheckpointInput,
  listRunRangeCheckpoints,
  listRunUndoRecords,
  listThreadCheckpoints,
  readCheckpointRecord,
  recordEditCheckpoint,
  sha256Hex,
  stampCheckpointReverted,
} from '../../assistant-server/edit-checkpoint-journal';

let db: PGlite & EditCheckpointDatabase;

const THREAD = 'thread-1';
const RESOURCE = 'workspace-a';
const RUN = 'run-1';
const ROOT = 'root-1';
const RUNS_TABLE = 'brainstrike_assistant_thread_runs';

function writeInput(overrides: Partial<EditCheckpointInput> = {}): EditCheckpointInput {
  const before = 'before-bytes\n';
  return {
    afterExisted: true,
    afterHash: sha256Hex('after-bytes\n'),
    beforeExisted: true,
    beforeHash: sha256Hex(before),
    beforeSize: Buffer.byteLength(before),
    captureStatus: 'ok',
    op: 'string_replace',
    path: '/a.txt',
    resourceId: RESOURCE,
    rootId: ROOT,
    runId: RUN,
    threadId: THREAD,
    toolCallId: 'call-1',
    toolName: 'brainstrike.stringReplaceWorkspaceFile',
    ...overrides,
  } as EditCheckpointInput;
}

/**
 * Migration 118 creates the runs table, so `migrate(db)` in `beforeEach`
 * already has it. What a run still needs is its `mastra_threads` parent: the
 * table's `thread_id` foreign key has been there since the run header first
 * shipped, and only this suite's three-column stand-in — a hand-rolled copy of
 * bootstrap DDL, written when the chain did not create the table — ever let a
 * run hang off a thread that did not exist.
 *
 * Both threads are seeded together: the anchor-resolution cases below pair
 * `THREAD` with a `thread-2` decoy that pins thread scoping.
 */
async function seedRunThreads(): Promise<void> {
  for (const threadId of [THREAD, 'thread-2']) {
    await db.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [threadId, RESOURCE, `Thread ${threadId}`]
    );
  }
}

/**
 * `startedAt` accepts a raw SQL-literal string (e.g. a microsecond-precision
 * timestamp such as `'2026-08-04 04:15:00.123456+00'`) as well as a `Date`,
 * so a test can insert a run with sub-millisecond precision that a `Date` —
 * millisecond-resolution — could never represent in the first place.
 */
async function insertRun(input: {
  id: string;
  startedAt: Date | string;
  threadId?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO ${RUNS_TABLE}
       (id, resource_id, thread_id, provider, model, runtime_kind, status,
        started_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'anthropic', 'test-model', 'hosted', 'completed', $4, NOW(), NOW())`,
    [input.id, RESOURCE, input.threadId ?? THREAD, input.startedAt]
  );
}

async function runsTableIsPresent(): Promise<boolean> {
  const probe = await db.query<{ present: boolean }>(
    `SELECT to_regclass('${RUNS_TABLE}') IS NOT NULL AS present`
  );
  return probe.rows[0]?.present === true;
}

beforeEach(async () => {
  db = await wasmLoader.createPGlite('memory://edit-checkpoint-journal');
  await migrate(db);
  Reflect.deleteProperty(process.env, 'BRAINSTRIKE_CHECKPOINT_MAX_ROWS');
});

afterEach(async () => {
  Reflect.deleteProperty(process.env, 'BRAINSTRIKE_CHECKPOINT_MAX_ROWS');
  await db.close();
});

describe('recordEditCheckpoint + listThreadCheckpoints', () => {
  it('inserts a row and returns it without before_content', async () => {
    const record = await recordEditCheckpoint(db, writeInput());
    expect(record.op).toBe('string_replace');
    expect(record.captureStatus).toBe('ok');
    expect(record.beforeExisted).toBe(true);
    expect(record.toolCallId).toBe('call-1');
    expect(record).not.toHaveProperty('beforeContent');

    const listed = await listThreadCheckpoints(db, THREAD);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(record.id);
  });

  it('records each op; a rename carries fromPath and no content', async () => {
    await recordEditCheckpoint(db, writeInput({ op: 'write', path: '/w.txt' }));
    await recordEditCheckpoint(
      db,
      writeInput({
        afterExisted: false,
        afterHash: null,
        beforeExisted: true,
        op: 'delete',
        path: '/d.txt',
      })
    );
    await recordEditCheckpoint(
      db,
      writeInput({
        beforeHash: null,
        beforeSize: null,
        captureStatus: 'rename',
        fromPath: '/old.txt',
        op: 'rename',
        path: '/new.txt',
      })
    );

    const listed = await listThreadCheckpoints(db, THREAD);
    const byOp = new Map(listed.map((entry) => [entry.op, entry]));
    expect(byOp.get('rename')?.fromPath).toBe('/old.txt');
    expect(byOp.get('rename')?.path).toBe('/new.txt');
    expect(byOp.get('write')?.fromPath).toBeNull();
    expect(byOp.get('delete')?.afterExisted).toBe(false);
  });

  it('NEVER stores before_content — the schema column stays NULL for every op (BST-1164 T4 demotion pin)', async () => {
    await recordEditCheckpoint(db, writeInput({ op: 'write', path: '/w.txt' }));
    await recordEditCheckpoint(db, writeInput({ path: '/sr.txt' }));
    await recordEditCheckpoint(
      db,
      writeInput({ afterExisted: false, afterHash: null, op: 'delete', path: '/d.txt' })
    );
    await recordEditCheckpoint(
      db,
      writeInput({
        beforeHash: null,
        beforeSize: null,
        captureStatus: 'rename',
        fromPath: '/from.txt',
        op: 'rename',
        path: '/to.txt',
      })
    );

    const stored = await db.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_assistant_edit_checkpoints WHERE before_content IS NOT NULL'
    );
    expect(Number(stored.rows[0]?.count)).toBe(0);
    // Attribution stays: hashes and sizes are still recorded.
    const listed = await listThreadCheckpoints(db, THREAD);
    expect(listed.find((entry) => entry.path === '/sr.txt')?.beforeHash).not.toBeNull();
  });

  it('lists rows ordered by occurred_at ASC, id ASC', async () => {
    const base = Date.now();
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(base + 2000), path: '/second.txt' })
    );
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(base + 1000), path: '/first.txt' })
    );
    const listed = await listThreadCheckpoints(db, THREAD);
    expect(listed.map((entry) => entry.path)).toEqual(['/first.txt', '/second.txt']);
  });
});

describe('undo worklist + reverted stamping', () => {
  it('listRunUndoRecords returns only that run’s NON-reverted records, newest-first', async () => {
    const base = Date.now();
    const oldest = await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(base + 1000), path: '/b-first.txt', runId: RUN })
    );
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(base + 2000), path: '/b-second.txt', runId: RUN })
    );
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(base + 1500), path: '/other-run.txt', runId: 'run-other' })
    );

    const listed = await listRunUndoRecords(db, RUN);
    expect(listed.map((entry) => entry.path)).toEqual(['/b-second.txt', '/b-first.txt']);

    // Stamping removes a record from the worklist (idempotent undo).
    const stamped = await stampCheckpointReverted(db, oldest.id);
    expect(stamped?.revertedAt).not.toBeNull();
    const after = await listRunUndoRecords(db, RUN);
    expect(after.map((entry) => entry.path)).toEqual(['/b-second.txt']);
  });

  it('readCheckpointRecord returns the attribution DTO by id, and null for an unknown id', async () => {
    const record = await recordEditCheckpoint(db, writeInput());
    const read = await readCheckpointRecord(db, record.id);
    expect(read?.id).toBe(record.id);
    expect(read).not.toHaveProperty('beforeContent');
    expect(await readCheckpointRecord(db, 'no-such-id')).toBeNull();
  });

  it('stampCheckpointReverted returns null for a vanished id (retention raced the undo)', async () => {
    expect(await stampCheckpointReverted(db, 'no-such-id')).toBeNull();
  });
});

describe('listRunRangeCheckpoints', () => {
  /**
   * NOT a supported input — a FAILURE-MODE pin (BST-1651).
   *
   * Migration 118 owns the run header, and `getDatabase()` cannot resolve a
   * handle before `migrate()` has run (`db-main.ts`), so main never sees this
   * relation absent. The `DROP` below manufactures a state the product cannot
   * enter, purely to pin how the module behaves if it ever did: it raises the
   * missing-relation error AS ITSELF. There is deliberately no probe, no
   * `runs-unavailable:` envelope, and no bootstrap — a soft answer here would
   * dress "this database was never migrated" up as an empty view, which is the
   * silent degradation the retired probe had become.
   */
  it('lets an unmigrated database raise 42P01 as itself, and still issues no DDL', async () => {
    // Both relations go: 118 creates the run header and its event timeline
    // together, and the timeline's foreign key means the parent cannot be
    // dropped alone.
    // Migration 127 adds another dependent relation to this intentionally missing-schema fixture.
    await db.query(
      'ALTER TABLE brainstrike_assistant_run_usage DROP CONSTRAINT brainstrike_assistant_run_usage_delegation_fk'
    );
    await db.query('DROP TABLE brainstrike_delegated_tool_decisions');
    await db.query('DROP TABLE brainstrike_delegated_invocations');
    await db.query('DROP TABLE brainstrike_assistant_run_events');
    await db.query('DROP TABLE brainstrike_delegation_step_reservations');
    await db.query(`DROP TABLE ${RUNS_TABLE}`);
    expect(await runsTableIsPresent()).toBe(false);

    // The code, never the prose: 42P01 is `undefined_table`. `rejects` also
    // fails loudly if the call ever RESOLVES again.
    await expect(
      listRunRangeCheckpoints(db, { fromRunId: 'run-a', threadId: THREAD })
    ).rejects.toMatchObject({ code: '42P01' });
    // The read-only invariant survives the probe's removal: a failed read must
    // never fall through to a bootstrap.
    expect(await runsTableIsPresent()).toBe(false);
  });

  describe('with a bootstrapped runs table', () => {
    const base = Date.now();
    const at = (offsetMs: number): Date => new Date(base + offsetMs);

    beforeEach(async () => {
      await seedRunThreads();
      await insertRun({ id: 'run-a', startedAt: at(0) });
      await insertRun({ id: 'run-b', startedAt: at(1000) });
      await insertRun({ id: 'run-c', startedAt: at(2000) });
      await insertRun({ id: 'run-d', startedAt: at(3000) });
      await recordEditCheckpoint(
        db,
        writeInput({ occurredAt: at(0), path: '/a.txt', runId: 'run-a' })
      );
      await recordEditCheckpoint(
        db,
        writeInput({ occurredAt: at(1000), path: '/b.txt', runId: 'run-b' })
      );
      await recordEditCheckpoint(
        db,
        writeInput({ occurredAt: at(2000), path: '/c.txt', runId: 'run-c' })
      );
      await recordEditCheckpoint(
        db,
        writeInput({ occurredAt: at(3000), path: '/d.txt', runId: 'run-d' })
      );

      // A DECOY in a different thread ('thread-2'), timed at(1500) — inside
      // both the [run-a, run-c] and [run-b, ) windows below. Every exact-array
      // assertion in this describe therefore also pins thread scoping: if the
      // range or anchor query ever dropped its `thread_id = $1` filter, this
      // row (and its journal entry) would leak into results that must not
      // contain it.
      await insertRun({ id: 'run-thread-b-x', startedAt: at(1500), threadId: 'thread-2' });
      await recordEditCheckpoint(
        db,
        writeInput({
          occurredAt: at(1500),
          path: '/thread-b-x.txt',
          runId: 'run-thread-b-x',
          threadId: 'thread-2',
        })
      );
    });

    it('a full closed range includes both anchors and everything between, excluding runs outside (and the other thread’s decoy)', async () => {
      const result = await listRunRangeCheckpoints(db, {
        fromRunId: 'run-a',
        threadId: THREAD,
        toRunId: 'run-c',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((entry) => entry.path)).toEqual(['/a.txt', '/b.txt', '/c.txt']);
      }
    });

    it('an open-ended range (toRunId omitted) reaches the latest run (and excludes the other thread’s decoy)', async () => {
      const result = await listRunRangeCheckpoints(db, { fromRunId: 'run-b', threadId: THREAD });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((entry) => entry.path)).toEqual(['/b.txt', '/c.txt', '/d.txt']);
      }
    });

    it('a same-run range (from === to) returns exactly that run’s records', async () => {
      const result = await listRunRangeCheckpoints(db, {
        fromRunId: 'run-b',
        threadId: THREAD,
        toRunId: 'run-b',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((entry) => entry.path)).toEqual(['/b.txt']);
      }
    });

    it('a missing fromRunId anchor is a prefixed, typed error naming that id', async () => {
      const result = await listRunRangeCheckpoints(db, {
        fromRunId: 'run-missing',
        threadId: THREAD,
        toRunId: 'run-c',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^run-anchor-missing:/);
        expect(result.error).toContain('run-missing');
      }
    });

    it('a missing toRunId anchor is a prefixed, typed error naming that id', async () => {
      const result = await listRunRangeCheckpoints(db, {
        fromRunId: 'run-a',
        threadId: THREAD,
        toRunId: 'run-missing',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^run-anchor-missing:/);
        expect(result.error).toContain('run-missing');
      }
    });

    it('a toRunId that exists only in a different thread is reported as a missing anchor, never a cross-thread leak', async () => {
      const result = await listRunRangeCheckpoints(db, {
        fromRunId: 'run-a',
        threadId: THREAD,
        toRunId: 'run-thread-b-x',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^run-anchor-missing:/);
        expect(result.error).toContain('run-thread-b-x');
      }
    });

    it('an inverted range (toRunId started before fromRunId) is an honest empty view, not an error — a ruling, not an accident', async () => {
      // run-c started AFTER run-a, so anchoring `from` on run-c and `to` on
      // run-a means no run can satisfy both bounds. Both anchors resolve
      // fine; this exercises the `runIds.length === 0` early return distinct
      // from "anchors resolved but zero journal rows" below.
      const result = await listRunRangeCheckpoints(db, {
        fromRunId: 'run-c',
        threadId: THREAD,
        toRunId: 'run-a',
      });
      expect(result).toEqual({ ok: true, value: [] });
    });
  });

  it('valid anchors with zero journal rows yield an empty view, not an error', async () => {
    const zeroRowsBase = Date.now();
    await seedRunThreads();
    await insertRun({ id: 'run-i', startedAt: new Date(zeroRowsBase) });
    await insertRun({ id: 'run-j', startedAt: new Date(zeroRowsBase + 1000) });

    const result = await listRunRangeCheckpoints(db, {
      fromRunId: 'run-i',
      threadId: THREAD,
      toRunId: 'run-j',
    });
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('preserves sub-millisecond started_at precision — a closed range anchored on its own run must not exclude itself', async () => {
    // A JS `Date` cannot represent this timestamp: it is millisecond
    // resolution and would truncate the ".123456" fraction. Inserted here as
    // a raw SQL-literal string so the DB stores the full microsecond value
    // from the start (see `insertRun`'s doc comment).
    const preciseStartedAt = '2026-08-04 04:15:00.123456+00';
    await seedRunThreads();
    await insertRun({ id: 'run-precise', startedAt: preciseStartedAt });
    await recordEditCheckpoint(
      db,
      writeInput({
        occurredAt: new Date('2026-08-04T04:15:00.123Z'),
        path: '/precise.txt',
        runId: 'run-precise',
      })
    );

    // If the anchor's started_at were ever routed through a JS `Date` (which
    // truncates the microsecond fraction) before being bound back in as the
    // upper bound, the truncated bound would sit BELOW the row's actual
    // (untruncated) started_at, and this row — its own range anchor — would
    // be excluded: an honest range would incorrectly look empty.
    const result = await listRunRangeCheckpoints(db, {
      fromRunId: 'run-precise',
      threadId: THREAD,
      toRunId: 'run-precise',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((entry) => entry.path)).toEqual(['/precise.txt']);
    }
  });

  it('same-millisecond runs: the id tiebreak makes range membership deterministic', async () => {
    const tieBase = Date.now();
    const tied = new Date(tieBase + 5000);
    await seedRunThreads();
    await insertRun({ id: 'run-before', startedAt: new Date(tieBase + 4000) });
    // Two runs sharing the exact same started_at; 'run-e' sorts before 'run-f'.
    await insertRun({ id: 'run-e', startedAt: tied });
    await insertRun({ id: 'run-f', startedAt: tied });
    await insertRun({ id: 'run-after', startedAt: new Date(tieBase + 6000) });
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(tieBase + 4000), path: '/before.txt', runId: 'run-before' })
    );
    // Journal occurredAt values are kept distinct even though the two runs'
    // started_at is tied — the tiebreak under test is the RANGE MEMBERSHIP
    // query over the runs table, not journal-row ordering (which is its own,
    // separately-tested occurred_at/id sort and would otherwise make this
    // assertion's expected order depend on a randomly-generated row id).
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: tied, path: '/e.txt', runId: 'run-e' })
    );
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(tieBase + 5500), path: '/f.txt', runId: 'run-f' })
    );
    await recordEditCheckpoint(
      db,
      writeInput({ occurredAt: new Date(tieBase + 6000), path: '/after.txt', runId: 'run-after' })
    );

    // Anchoring the open-ended range on 'run-f' (the lexically LATER of the two
    // tied runs) must exclude 'run-e': if the query compared started_at alone,
    // 'run-e' would incorrectly tie into the range too.
    const openEnded = await listRunRangeCheckpoints(db, { fromRunId: 'run-f', threadId: THREAD });
    expect(openEnded.ok).toBe(true);
    if (openEnded.ok) {
      expect(openEnded.value.map((entry) => entry.path)).toEqual(['/f.txt', '/after.txt']);
    }

    // A closed range spanning both tied runs picks up exactly the two of them.
    const closed = await listRunRangeCheckpoints(db, {
      fromRunId: 'run-e',
      threadId: THREAD,
      toRunId: 'run-f',
    });
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.value.map((entry) => entry.path)).toEqual(['/e.txt', '/f.txt']);
    }
  });
});

describe('retention', () => {
  it('hard-deletes the oldest rows beyond the row cap', async () => {
    process.env['BRAINSTRIKE_CHECKPOINT_MAX_ROWS'] = '2';
    const base = Date.now();
    for (let index = 0; index < 4; index += 1) {
      await recordEditCheckpoint(
        db,
        writeInput({ occurredAt: new Date(base + index * 1000), path: `/f${index}.txt` })
      );
    }
    const listed = await listThreadCheckpoints(db, THREAD);
    expect(listed).toHaveLength(2);
    expect(listed.map((entry) => entry.path)).toEqual(['/f2.txt', '/f3.txt']);
  });

  it('throws on a malformed retention override (no silent fallback)', async () => {
    process.env['BRAINSTRIKE_CHECKPOINT_MAX_ROWS'] = 'not-a-number';
    await expect(recordEditCheckpoint(db, writeInput())).rejects.toThrow(
      /BRAINSTRIKE_CHECKPOINT_MAX_ROWS/
    );
  });
});
