/**
 * Snapshot-backed checkpoint undo (BST-1164 T4) against REAL git + REAL
 * PGlite — the Option-A port: per-file / per-turn undo restores paths to the
 * TURN-START snapshot state, attribution comes from the (content-free)
 * journal, and unavailability is typed data, never a click-time surprise.
 *
 * MUTATION VERIFICATION (destructive seam; each mutation applied, confirmed
 * to fail the named test, then reverted — see the workstream report):
 * - Inverting `diskMatches`'s HASH comparison in `checkpoint-snapshot-undo.ts`
 *   fails "refuses with a conflict when the file changed after the edit …".
 * - Inverting its EXISTENCE branch fails "refuses with a conflict when the
 *   file was DELETED after the edit (presence flip)".
 * - Making `restoreOneSnapshotPath` (snapshot-service.ts) claim `restored`
 *   for an absent tree entry without unlinking (dropping the delete) fails
 *   "undoes a created file by deleting it …".
 */

import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckpointReindexAction } from '../../assistant-server/checkpoint-reindex-deps';
import {
  CHECKPOINT_UNDO_PREDATES_SNAPSHOTS_REASON,
  type CheckpointUndoDeps,
  listCheckpointUndoAvailability,
  undoCheckpointEntry,
  undoCheckpointRun,
} from '../../assistant-server/checkpoint-snapshot-undo';
import {
  type EditCheckpointDatabase,
  type EditCheckpointInput,
  recordEditCheckpoint,
  sha256Hex,
} from '../../assistant-server/edit-checkpoint-journal';
import { execFileSnapshotGitRunner } from '../../assistant-server/snapshot-git';
import {
  createSnapshotRepository,
  FAILED_SNAPSHOT_CAPTURE_OID,
  type SnapshotRepository,
} from '../../assistant-server/snapshot-repository';
import {
  createSnapshotService,
  type ShadowRepoHandle,
  type SnapshotService,
} from '../../assistant-server/snapshot-service';
import { createSnapshotTurnRegistry } from '../../assistant-server/snapshot-turn-registry';

const execFileAsync = promisify(execFile);
const HEAVY_TIMEOUT_MS = 60_000;

const THREAD = 'thread-undo';
const RESOURCE = 'workspace-a';
const RUN = 'run-undo-1';
const ROOT_ID = 'root-undo';

let db: PGlite & EditCheckpointDatabase;
let rootPath: string;
let snapshotsBase: string;
let service: SnapshotService;
let repository: SnapshotRepository;
let handle: ShadowRepoHandle;
let reindexActions: CheckpointReindexAction[];

function undoDeps(): CheckpointUndoDeps {
  return {
    readRunAnchor: async () => ({ ok: true, value: null }),
    registry: createSnapshotTurnRegistry(),
    reindex: async (action) => {
      reindexActions.push(action);
    },
    snapshotRepository: repository,
    snapshotService: service,
  };
}

async function write(relative: string, content: string): Promise<void> {
  const absolute = path.join(rootPath, relative);
  await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
  await fsPromises.writeFile(absolute, content, 'utf8');
}

async function readOrNull(relative: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(path.join(rootPath, relative), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Take + ledger-record a turn-start snapshot for the fixture root. */
async function recordTurnStart(runId = RUN): Promise<string> {
  const { commitOid } = await service.snapshot(handle, {
    kind: 'turn-start',
    runId,
    threadId: THREAD,
  });
  await repository.insertSnapshot({
    commitOid,
    kind: 'turn-start',
    rootId: ROOT_ID,
    rootPath: handle.rootPath,
    runId,
    threadId: THREAD,
  });
  return commitOid;
}

function journalInput(overrides: Partial<EditCheckpointInput> = {}): EditCheckpointInput {
  return {
    afterExisted: true,
    afterHash: null,
    beforeExisted: true,
    beforeHash: null,
    beforeSize: null,
    captureStatus: 'ok',
    op: 'write',
    path: 'a.txt',
    resourceId: RESOURCE,
    rootId: ROOT_ID,
    runId: RUN,
    threadId: THREAD,
    toolCallId: 'call-1',
    toolName: 'brainstrike.writeWorkspaceFile',
    ...overrides,
  } as EditCheckpointInput;
}

async function hashOf(content: string): Promise<string> {
  return sha256Hex(content);
}

beforeEach(async () => {
  db = await wasmLoader.createPGlite('memory://checkpoint-snapshot-undo');
  await migrate(db);
  rootPath = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-undo-root-'))
  );
  snapshotsBase = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-undo-shadow-'))
  );
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path, status, created_at)
     VALUES ($1, 'path', 'Undo Project', $2, 'live', $3)`,
    [ROOT_ID, rootPath, new Date().toISOString()]
  );
  service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: snapshotsBase,
  });
  repository = createSnapshotRepository(db);
  reindexActions = [];
  handle = await service.ensureShadowRepo({ path: rootPath, rootId: ROOT_ID });
});

afterEach(async () => {
  await db.close();
  await fsPromises.rm(rootPath, { force: true, recursive: true });
  await fsPromises.rm(snapshotsBase, { force: true, recursive: true });
});

describe('undoCheckpointEntry', () => {
  it('restores a modified file to its TURN-START content (not just-before-the-edit) and stamps reverted_at', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('a.txt', 'turn-start\n');
    await recordTurnStart();
    // Two edits in the turn; undoing the SECOND still lands on turn-start —
    // the deliberate semantic change.
    await write('a.txt', 'edit-1\n');
    await write('a.txt', 'edit-2\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edit-2\n') })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.revertedAt).not.toBeNull();
    }
    expect(await readOrNull('a.txt')).toBe('turn-start\n');
    expect(reindexActions).toEqual([
      expect.objectContaining({ kind: 'restore', rootId: ROOT_ID, workspacePath: 'a.txt' }),
    ]);

    // Idempotent: a second undo is a no-op success.
    const again = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(again.ok).toBe(true);
  });

  it('undoes a created file by deleting it and pruning now-empty scaffold dirs', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('keep.txt', 'keep\n');
    await recordTurnStart();
    await write('scaffold/deep/new.txt', 'created\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('created\n'),
        beforeExisted: false,
        captureStatus: 'created',
        path: 'scaffold/deep/new.txt',
      })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(true);
    expect(await readOrNull('scaffold/deep/new.txt')).toBeNull();
    // Empty scaffold ancestors are pruned, the root itself untouched.
    await expect(fsPromises.stat(path.join(rootPath, 'scaffold'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readOrNull('keep.txt')).toBe('keep\n');
    expect(reindexActions).toEqual([
      expect.objectContaining({ kind: 'delete', workspacePath: 'scaffold/deep/new.txt' }),
    ]);
  });

  it('undoes a delete by recreating the file from the turn-start snapshot', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('doomed.txt', 'precious\n');
    await recordTurnStart();
    await fsPromises.unlink(path.join(rootPath, 'doomed.txt'));
    const record = await recordEditCheckpoint(
      db,
      journalInput({
        afterExisted: false,
        afterHash: null,
        beforeHash: await hashOf('precious\n'),
        op: 'delete',
        path: 'doomed.txt',
      })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(true);
    expect(await readOrNull('doomed.txt')).toBe('precious\n');
  });

  it('undoes a rename by restoring the source and deleting the destination', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('old-name.txt', 'contents\n');
    await recordTurnStart();
    await fsPromises.rename(
      path.join(rootPath, 'old-name.txt'),
      path.join(rootPath, 'new-name.txt')
    );
    const record = await recordEditCheckpoint(
      db,
      journalInput({
        beforeHash: null,
        captureStatus: 'rename',
        fromPath: 'old-name.txt',
        op: 'rename',
        path: 'new-name.txt',
      })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(true);
    expect(await readOrNull('old-name.txt')).toBe('contents\n');
    expect(await readOrNull('new-name.txt')).toBeNull();
  });

  it('refuses with a conflict when the file changed after the edit, and force overrides', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('a.txt', 'turn-start\n');
    await recordTurnStart();
    await write('a.txt', 'edit\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edit\n') })
    );
    // A LATER change (user hand edit) the undo must not silently destroy.
    await write('a.txt', 'hand-edit\n');

    const refused = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('conflict');
    }
    expect(await readOrNull('a.txt')).toBe('hand-edit\n');

    const forced = await undoCheckpointEntry(db, { force: true, id: record.id }, undoDeps());
    expect(forced.ok).toBe(true);
    expect(await readOrNull('a.txt')).toBe('turn-start\n');
  });

  it('refuses with a conflict when the file was DELETED after the edit (presence flip)', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('a.txt', 'turn-start\n');
    await recordTurnStart();
    await write('a.txt', 'edit\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edit\n') })
    );
    await fsPromises.unlink(path.join(rootPath, 'a.txt'));

    const refused = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('conflict');
    }
    expect(await readOrNull('a.txt')).toBeNull();
  });

  it('refuses (typed, with the predates reason) when the thread has no snapshot rows', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('a.txt', 'edit\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edit\n') })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_revertible');
      expect(result.message).toBe(CHECKPOINT_UNDO_PREDATES_SNAPSHOTS_REASON);
    }
    expect(await readOrNull('a.txt')).toBe('edit\n');
  });

  it('refuses when the turn-start capture for the root FAILED (sentinel row)', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await repository.insertSnapshot({
      commitOid: FAILED_SNAPSHOT_CAPTURE_OID,
      kind: 'turn-start',
      rootId: ROOT_ID,
      rootPath: handle.rootPath,
      runId: RUN,
      threadId: THREAD,
    });
    await write('a.txt', 'edit\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edit\n') })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_revertible');
      expect(result.message).toContain('failed to capture');
    }
  });

  it('returns not_found for an unknown id', async () => {
    const result = await undoCheckpointEntry(db, { id: 'no-such-id' }, undoDeps());
    expect(result).toMatchObject({ code: 'not_found', ok: false });
  });
});

describe('undoCheckpointRun', () => {
  it('restores every touched path to turn-start exactly once, newest-first, and stamps every record', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    await write('a.txt', 'turn-start-a\n');
    await recordTurnStart();
    const base = Date.now();
    // Two edits of the SAME file plus a created file, all one run.
    await write('a.txt', 'edit-1\n');
    await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('edit-1\n'),
        occurredAt: new Date(base + 1000),
        toolCallId: 'call-1',
      })
    );
    await write('a.txt', 'edit-2\n');
    await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('edit-2\n'),
        occurredAt: new Date(base + 2000),
        toolCallId: 'call-2',
      })
    );
    await write('b.txt', 'created\n');
    await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('created\n'),
        beforeExisted: false,
        captureStatus: 'created',
        occurredAt: new Date(base + 3000),
        path: 'b.txt',
        toolCallId: 'call-3',
      })
    );

    const result = await undoCheckpointRun(db, { runId: RUN }, undoDeps());
    expect(result.outcomes).toHaveLength(3);
    // The OLDER edit of a.txt must not conflict against the restored
    // turn-start bytes: its path was already handled by the newest record,
    // so it stamps without re-touching disk.
    expect(result.outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(await readOrNull('a.txt')).toBe('turn-start-a\n');
    expect(await readOrNull('b.txt')).toBeNull();
    // a.txt restored once, b.txt deleted once — no duplicate restore.
    expect(reindexActions).toHaveLength(2);

    const remaining = await undoCheckpointRun(db, { runId: RUN }, undoDeps());
    expect(remaining.outcomes).toHaveLength(0);
  });
});

describe('listCheckpointUndoAvailability', () => {
  it('classifies covered, pre-engine, and failed-capture entries per checkpoint id', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    // Pre-engine record: a run with NO snapshot rows at all yet.
    const preEngine = await recordEditCheckpoint(
      db,
      journalInput({ path: 'pre.txt', runId: 'run-pre-engine', toolCallId: 'call-pre' })
    );
    const availabilityBefore = await listCheckpointUndoAvailability(db, undoDeps(), THREAD);
    expect(availabilityBefore.byCheckpointId[preEngine.id]).toEqual({
      reason: CHECKPOINT_UNDO_PREDATES_SNAPSHOTS_REASON,
      restorable: false,
    });

    // Covered record.
    await write('a.txt', 'turn-start\n');
    await recordTurnStart();
    const covered = await recordEditCheckpoint(db, journalInput({ afterHash: await hashOf('x') }));
    // Failed-capture record: its own later turn recorded a sentinel row.
    await repository.insertSnapshot({
      commitOid: FAILED_SNAPSHOT_CAPTURE_OID,
      kind: 'turn-start',
      rootId: ROOT_ID,
      rootPath: handle.rootPath,
      runId: 'run-failed',
      threadId: THREAD,
    });
    const failed = await recordEditCheckpoint(
      db,
      journalInput({ path: 'f.txt', runId: 'run-failed', toolCallId: 'call-f' })
    );

    const availability = await listCheckpointUndoAvailability(db, undoDeps(), THREAD);
    expect(availability.byCheckpointId[covered.id]).toEqual({ restorable: true });
    expect(availability.byCheckpointId[failed.id]).toMatchObject({ restorable: false });
  });

  it('returns an empty map for a thread with no journal rows', async () => {
    const availability = await listCheckpointUndoAvailability(db, undoDeps(), 'thread-empty');
    expect(availability.byCheckpointId).toEqual({});
  });
});

// Sanity: the production runner really is exercised (not a stub) — the shadow
// repo exists on disk with the pinned layout.
it('creates the shadow repo under <base>/<rootId>/git', async () => {
  const headPath = path.join(snapshotsBase, ROOT_ID, 'git', 'HEAD');
  await expect(fsPromises.access(headPath)).resolves.toBeUndefined();
  const { stdout } = await execFileAsync('git', [
    '--git-dir',
    path.dirname(headPath),
    'rev-parse',
    '--is-bare-repository',
  ]);
  expect(stdout.trim()).toBe('false');
});
