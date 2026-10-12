/**
 * Attribution-ledger readers against REAL PGlite: the thread listing, the
 * undo worklist, the record read and the reverted stamp that the snapshot
 * undo engine (`checkpoint-snapshot-undo.ts`) uses. Since BST-1164 T4 a row
 * carries identity only (op, paths, hashes, timestamps), never content.
 */

import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EditCheckpointDatabase,
  listRunUndoRecords,
  listThreadCheckpoints,
  readCheckpointRecord,
  sha256Hex,
  stampCheckpointReverted,
} from '../../assistant-server/edit-checkpoint-journal';
import {
  type EditCheckpointRowInput,
  insertEditCheckpointRow,
} from './edit-checkpoint-test-support';

let db: PGlite & EditCheckpointDatabase;

const THREAD = 'thread-1';
const RESOURCE = 'workspace-a';
const RUN = 'run-1';
const ROOT = 'root-1';

function rowInput(overrides: Partial<EditCheckpointRowInput> = {}): EditCheckpointRowInput {
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
  } as EditCheckpointRowInput;
}

beforeEach(async () => {
  db = await wasmLoader.createPGlite('memory://edit-checkpoint-journal');
  await migrate(db);
});

afterEach(async () => {
  await db.close();
});

describe('listThreadCheckpoints', () => {
  it('lists rows ordered by occurred_at ASC, id ASC, without content', async () => {
    const base = Date.now();
    await insertEditCheckpointRow(
      db,
      rowInput({ occurredAt: new Date(base + 2000), path: '/second.txt' })
    );
    await insertEditCheckpointRow(
      db,
      rowInput({ occurredAt: new Date(base + 1000), path: '/first.txt' })
    );
    const listed = await listThreadCheckpoints(db, THREAD);
    expect(listed.map((entry) => entry.path)).toEqual(['/first.txt', '/second.txt']);
    expect(listed[0]).not.toHaveProperty('beforeContent');
  });

  it('maps every op; a rename carries fromPath', async () => {
    await insertEditCheckpointRow(db, rowInput({ op: 'write', path: '/w.txt' }));
    await insertEditCheckpointRow(
      db,
      rowInput({
        afterExisted: false,
        afterHash: null,
        beforeExisted: true,
        op: 'delete',
        path: '/d.txt',
      })
    );
    await insertEditCheckpointRow(
      db,
      rowInput({
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
});

describe('undo worklist + reverted stamping', () => {
  it('listRunUndoRecords returns only that run’s NON-reverted records, newest-first', async () => {
    const base = Date.now();
    const oldest = await insertEditCheckpointRow(
      db,
      rowInput({ occurredAt: new Date(base + 1000), path: '/b-first.txt', runId: RUN })
    );
    await insertEditCheckpointRow(
      db,
      rowInput({ occurredAt: new Date(base + 2000), path: '/b-second.txt', runId: RUN })
    );
    await insertEditCheckpointRow(
      db,
      rowInput({ occurredAt: new Date(base + 1500), path: '/other-run.txt', runId: 'run-other' })
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
    const record = await insertEditCheckpointRow(db, rowInput());
    const read = await readCheckpointRecord(db, record.id);
    expect(read?.id).toBe(record.id);
    expect(read?.toolCallId).toBe('call-1');
    expect(read).not.toHaveProperty('beforeContent');
    expect(await readCheckpointRecord(db, 'no-such-id')).toBeNull();
  });

  it('stampCheckpointReverted returns null for a vanished id', async () => {
    expect(await stampCheckpointReverted(db, 'no-such-id')).toBeNull();
  });
});
