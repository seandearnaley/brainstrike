/**
 * Revert executor — per-op inverse, conflict detection, force, run-revert.
 * REAL PGlite + REAL fs in a tmp workspace + a REAL seeded roots row. The reindex
 * seam is a spy (asserted invoked); the write primitives are the audited helpers.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The revert executor reuses the audited write helpers from assistant-tools,
// which imports electron + db-main at module eval — stub both. getDatabase is
// never called (the reindex seam is injected as a spy).
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => {
    throw new Error('getDatabase should not be called in the revert executor tests');
  }),
}));

import {
  type EditCheckpointInput,
  recordEditCheckpoint,
  sha256Hex,
} from '../../assistant-server/edit-checkpoint-journal';
import {
  type CheckpointReindexAction,
  revertCheckpointEntry,
  revertCheckpointRun,
} from '../../assistant-server/edit-checkpoint-revert';

let db: PGlite;
let rootPath: string;
const ROOT_ID = 'root-1';
const THREAD = 'thread-1';
const RUN = 'run-1';

const reindex = vi.fn<(action: CheckpointReindexAction) => Promise<void>>(async () => {
  // no-op spy
});

function deps() {
  return { reindex };
}

async function writeDiskFile(rel: string, content: string): Promise<void> {
  const abs = path.join(rootPath, rel);
  await fsPromises.mkdir(path.dirname(abs), { recursive: true });
  await fsPromises.writeFile(abs, content, 'utf8');
}

async function readDiskFile(rel: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(path.join(rootPath, rel), 'utf8');
  } catch {
    return null;
  }
}

async function seed(input: Partial<EditCheckpointInput> & { op: EditCheckpointInput['op'] }) {
  const base = {
    afterExisted: true,
    afterHash: null,
    beforeContent: null,
    beforeExisted: true,
    beforeHash: null,
    beforeSize: null,
    captureStatus: 'ok' as const,
    resourceId: 'workspace-a',
    rootId: ROOT_ID,
    runId: RUN,
    threadId: THREAD,
    toolName: 'brainstrike.writeWorkspaceFile',
  };
  return recordEditCheckpoint(db, { ...base, ...input } as EditCheckpointInput);
}

beforeEach(async () => {
  reindex.mockClear();
  rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-ckpt-revert-'));
  db = await wasmLoader.createPGlite('memory://edit-checkpoint-revert');
  await migrate(db);
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path, status, created_at)
     VALUES ($1, 'path', 'Project', $2, 'live', $3)`,
    [ROOT_ID, rootPath, new Date().toISOString()]
  );
});

afterEach(async () => {
  await db.close();
  await fsPromises.rm(rootPath, { force: true, recursive: true });
});

describe('revertCheckpointEntry', () => {
  it('restores before-content for a write (status ok) and reindexes', async () => {
    await writeDiskFile('a.txt', 'AFTER');
    const record = await seed({
      afterHash: sha256Hex('AFTER'),
      beforeContent: 'BEFORE',
      beforeHash: sha256Hex('BEFORE'),
      beforeSize: 6,
      op: 'write',
      path: '/a.txt',
    });

    const result = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(result.ok).toBe(true);
    expect(await readDiskFile('a.txt')).toBe('BEFORE');
    expect(reindex).toHaveBeenCalledWith(expect.objectContaining({ kind: 'restore' }));
    if (result.ok) {
      expect(result.entry.revertedAt).not.toBeNull();
    }
  });

  it('deletes a created file (status created)', async () => {
    await writeDiskFile('new.txt', 'CREATED');
    const record = await seed({
      afterExisted: true,
      afterHash: sha256Hex('CREATED'),
      beforeExisted: false,
      captureStatus: 'created',
      op: 'write',
      path: '/new.txt',
    });

    const result = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(result.ok).toBe(true);
    expect(await readDiskFile('new.txt')).toBeNull();
    expect(reindex).toHaveBeenCalledWith(expect.objectContaining({ kind: 'delete' }));
  });

  it('recreates a deleted file (op delete)', async () => {
    const record = await seed({
      afterExisted: false,
      afterHash: null,
      beforeContent: 'GONE',
      beforeExisted: true,
      beforeHash: sha256Hex('GONE'),
      beforeSize: 4,
      op: 'delete',
      path: '/d.txt',
    });

    const result = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(result.ok).toBe(true);
    expect(await readDiskFile('d.txt')).toBe('GONE');
  });

  it('renames a file back (op rename)', async () => {
    await writeDiskFile('new-name.txt', 'MOVED');
    const record = await seed({
      afterExisted: true,
      captureStatus: 'rename',
      fromPath: '/old-name.txt',
      op: 'rename',
      path: '/new-name.txt',
    });

    const result = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(result.ok).toBe(true);
    expect(await readDiskFile('new-name.txt')).toBeNull();
    expect(await readDiskFile('old-name.txt')).toBe('MOVED');
    expect(reindex).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rename' }));
  });

  it('refuses on a post-checkpoint change (conflict) and force overrides', async () => {
    await writeDiskFile('c.txt', 'AFTER');
    const record = await seed({
      afterHash: sha256Hex('AFTER'),
      beforeContent: 'BEFORE',
      beforeHash: sha256Hex('BEFORE'),
      beforeSize: 6,
      op: 'write',
      path: '/c.txt',
    });
    // A third party edits the file after the checkpoint.
    await writeDiskFile('c.txt', 'HAND-EDITED');

    const conflict = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe('conflict');
    }
    expect(await readDiskFile('c.txt')).toBe('HAND-EDITED');

    const forced = await revertCheckpointEntry(db, { force: true, id: record.id }, deps());
    expect(forced.ok).toBe(true);
    expect(await readDiskFile('c.txt')).toBe('BEFORE');
  });

  it('refuses a skipped_binary entry as not_revertible', async () => {
    const record = await seed({
      beforeContent: null,
      beforeHash: sha256Hex('bin'),
      beforeSize: 4096,
      captureStatus: 'skipped_binary',
      op: 'write',
      path: '/bin.dat',
    });
    const result = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_revertible');
    }
  });

  it('returns not_found for an unknown id', async () => {
    const result = await revertCheckpointEntry(db, { id: 'nope' }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
    }
  });

  it('is idempotent: a second revert is a no-op success', async () => {
    await writeDiskFile('i.txt', 'AFTER');
    const record = await seed({
      afterHash: sha256Hex('AFTER'),
      beforeContent: 'BEFORE',
      beforeHash: sha256Hex('BEFORE'),
      beforeSize: 6,
      op: 'write',
      path: '/i.txt',
    });
    await revertCheckpointEntry(db, { id: record.id }, deps());
    reindex.mockClear();
    const second = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(second.ok).toBe(true);
    expect(reindex).not.toHaveBeenCalled();
  });

  it('refuses a revert against a disconnected root', async () => {
    await writeDiskFile('r.txt', 'AFTER');
    const record = await seed({
      afterHash: sha256Hex('AFTER'),
      beforeContent: 'BEFORE',
      beforeHash: sha256Hex('BEFORE'),
      beforeSize: 6,
      op: 'write',
      path: '/r.txt',
    });
    await db.query("UPDATE roots SET status = 'disconnected' WHERE id = $1", [ROOT_ID]);
    const result = await revertCheckpointEntry(db, { id: record.id }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_revertible');
    }
  });
});

describe('revertCheckpointRun', () => {
  it('reverts multiple same-file edits in reverse order to the pre-turn state', async () => {
    // Two sequential edits to the same file in one turn: '' -> 'V1' -> 'V2'.
    await writeDiskFile('m.txt', 'V1');
    const base = Date.now();
    await seed({
      afterExisted: true,
      afterHash: sha256Hex('V1'),
      beforeContent: 'ORIGINAL',
      beforeHash: sha256Hex('ORIGINAL'),
      beforeSize: 8,
      occurredAt: new Date(base + 1000),
      op: 'write',
      path: '/m.txt',
    });
    await writeDiskFile('m.txt', 'V2');
    await seed({
      afterExisted: true,
      afterHash: sha256Hex('V2'),
      beforeContent: 'V1',
      beforeHash: sha256Hex('V1'),
      beforeSize: 2,
      occurredAt: new Date(base + 2000),
      op: 'write',
      path: '/m.txt',
    });

    const result = await revertCheckpointRun(db, { runId: RUN }, deps());
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((outcome) => outcome.ok)).toBe(true);
    // Reverse order: undo V2->V1, then V1->ORIGINAL.
    expect(await readDiskFile('m.txt')).toBe('ORIGINAL');
  });
});
