/**
 * Journal repository/executor — record + list + retention against REAL PGlite.
 * The capture status is supplied by the CALLER (Task 4 detects binary/oversize);
 * this module only persists what it is given and enforces retention.
 */

import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EditCheckpointInput,
  listThreadCheckpoints,
  recordEditCheckpoint,
  sha256Hex,
} from '../../assistant-server/edit-checkpoint-journal';

let db: PGlite;

const THREAD = 'thread-1';
const RESOURCE = 'workspace-a';
const RUN = 'run-1';
const ROOT = 'root-1';

function writeInput(overrides: Partial<EditCheckpointInput> = {}): EditCheckpointInput {
  const before = 'before-bytes\n';
  return {
    afterExisted: true,
    afterHash: sha256Hex('after-bytes\n'),
    beforeContent: before,
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

beforeEach(async () => {
  db = await wasmLoader.createPGlite('memory://edit-checkpoint-journal');
  await migrate(db);
  delete process.env.BRAINSTRIKE_CHECKPOINT_CONTENT_BUDGET_BYTES;
  delete process.env.BRAINSTRIKE_CHECKPOINT_MAX_ROWS;
});

afterEach(async () => {
  delete process.env.BRAINSTRIKE_CHECKPOINT_CONTENT_BUDGET_BYTES;
  delete process.env.BRAINSTRIKE_CHECKPOINT_MAX_ROWS;
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
        beforeContent: 'gone\n',
        beforeExisted: true,
        op: 'delete',
        path: '/d.txt',
      })
    );
    await recordEditCheckpoint(
      db,
      writeInput({
        beforeContent: null,
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

  it('persists a skipped_binary before-state: null content but non-null hash/size', async () => {
    const record = await recordEditCheckpoint(
      db,
      writeInput({
        beforeContent: null,
        beforeHash: sha256Hex('binary'),
        beforeSize: 4096,
        captureStatus: 'skipped_binary',
      })
    );
    expect(record.captureStatus).toBe('skipped_binary');
    expect(record.beforeHash).not.toBeNull();
    expect(record.beforeSize).toBe(4096);

    const stored = await db.query<{ before_content: string | null }>(
      'SELECT before_content FROM brainstrike_assistant_edit_checkpoints WHERE id = $1',
      [record.id]
    );
    expect(stored.rows[0]?.before_content).toBeNull();
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

describe('retention', () => {
  it('NULLs the oldest non-reverted before_content to "expired" when over the byte budget', async () => {
    // Budget below two entries' combined content but above one.
    const content = 'x'.repeat(1000);
    process.env.BRAINSTRIKE_CHECKPOINT_CONTENT_BUDGET_BYTES = '1500';
    const base = Date.now();
    const oldest = await recordEditCheckpoint(
      db,
      writeInput({
        beforeContent: content,
        beforeSize: content.length,
        occurredAt: new Date(base + 1000),
        path: '/old.txt',
      })
    );
    await recordEditCheckpoint(
      db,
      writeInput({
        beforeContent: content,
        beforeSize: content.length,
        occurredAt: new Date(base + 2000),
        path: '/new.txt',
      })
    );

    const listed = await listThreadCheckpoints(db, THREAD);
    const oldestEntry = listed.find((entry) => entry.id === oldest.id);
    expect(oldestEntry?.captureStatus).toBe('expired');

    const stored = await db.query<{ before_content: string | null }>(
      'SELECT before_content FROM brainstrike_assistant_edit_checkpoints WHERE id = $1',
      [oldest.id]
    );
    expect(stored.rows[0]?.before_content).toBeNull();

    // The newest entry keeps its content.
    const newest = listed.find((entry) => entry.path === '/new.txt');
    expect(newest?.captureStatus).toBe('ok');
  });

  it('hard-deletes the oldest rows beyond the row cap', async () => {
    process.env.BRAINSTRIKE_CHECKPOINT_MAX_ROWS = '2';
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
    process.env.BRAINSTRIKE_CHECKPOINT_MAX_ROWS = 'not-a-number';
    await expect(recordEditCheckpoint(db, writeInput())).rejects.toThrow(
      /BRAINSTRIKE_CHECKPOINT_MAX_ROWS/
    );
  });
});
