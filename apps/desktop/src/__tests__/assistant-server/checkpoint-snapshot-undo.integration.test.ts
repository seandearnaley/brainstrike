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
 * - COVERAGE GATE (BST-1164 review): inverting `requiresSnapshotPresence`'s
 *   `beforeExisted` gate (`checkpoint-snapshot-undo.ts` — the single source
 *   both the whole-record pre-check and the seam's `expectAbsent` derive
 *   from) fails "refuses (typed) a modify-undo of a GITIGNORED file …" (the
 *   file is DELETED with a green outcome) and "undoes a created file by
 *   deleting it …" (the created file survives as `uncovered`).
 * - Dropping the seam's `uncovered` refusal in `restoreOneSnapshotPath`
 *   (falling through to the delete for `expectAbsent: false`) fails the
 *   seam-level pin "refuses (uncovered, untouched) a snapshot-absent path
 *   the caller expected PRESENT" in
 *   `snapshot-service-gc.integration.test.ts` — the engine's own pre-check
 *   still refuses, which is exactly why the seam backstop needs its own pin.
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

/** Runtime case-insensitivity probe for the wrong-case-path fixture. */
async function isCaseInsensitiveFs(dir: string): Promise<boolean> {
  const probePath = path.join(dir, 'case-probe-lower.txt');
  await fsPromises.writeFile(probePath, 'probe', 'utf8');
  try {
    await fsPromises.access(path.join(dir, 'CASE-PROBE-LOWER.TXT'));
    return true;
  } catch {
    return false;
  } finally {
    await fsPromises.rm(probePath, { force: true });
  }
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
        // The capture site hashes the rename DESTINATION (same bytes the
        // rename moved) so the conflict gate can verify it — see the
        // destination-edited fixture below for why null is not acceptable.
        afterHash: await hashOf('contents\n'),
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

  it('refuses (conflict) a rename undo when the destination was EDITED after the rename — hashed row', {
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
        afterHash: await hashOf('contents\n'),
        beforeHash: null,
        captureStatus: 'rename',
        fromPath: 'old-name.txt',
        op: 'rename',
        path: 'new-name.txt',
      })
    );
    // The user keeps working in the renamed file — an unforced undo must not
    // delete those edits while restoring the source.
    await write('new-name.txt', 'contents\nplus user edits\n');

    const refused = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('conflict');
    }
    expect(await readOrNull('new-name.txt')).toBe('contents\nplus user edits\n');
    expect(await readOrNull('old-name.txt')).toBeNull();

    const forced = await undoCheckpointEntry(db, { force: true, id: record.id }, undoDeps());
    expect(forced.ok).toBe(true);
    expect(await readOrNull('old-name.txt')).toBe('contents\n');
    expect(await readOrNull('new-name.txt')).toBeNull();
  });

  it('treats a NULL afterHash on a present rename destination as unverifiable ⇒ conflict (never existence-only)', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    // Legacy rows (recorded before the capture site hashed rename
    // destinations) carry `afterHash: null`. Existence-only acceptance would
    // clobber post-rename user edits — the W7 review's P1. Fail-safe:
    // unverifiable ⇒ conflict, force still available.
    await write('old-name.txt', 'contents\n');
    await recordTurnStart();
    await fsPromises.rename(
      path.join(rootPath, 'old-name.txt'),
      path.join(rootPath, 'new-name.txt')
    );
    const record = await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: null,
        beforeHash: null,
        captureStatus: 'rename',
        fromPath: 'old-name.txt',
        op: 'rename',
        path: 'new-name.txt',
      })
    );
    await write('new-name.txt', 'contents\nplus user edits\n');

    const refused = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('conflict');
    }
    // The un-forced refusal left the user's edits alone.
    expect(await readOrNull('new-name.txt')).toBe('contents\nplus user edits\n');
    expect(await readOrNull('old-name.txt')).toBeNull();
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

  it('refuses (typed) a modify-undo of a GITIGNORED file instead of deleting it; availability reports the reason', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    // `add -A` respects .gitignore, so the turn-start snapshot NEVER contains
    // secret.env — but the edit journals `beforeExisted: true`. Before the
    // coverage gate this undo UNLINKED the file with a green 'deleted'
    // outcome, destroying pre-edit content that existed nowhere else.
    await write('.gitignore', 'secret.env\n');
    await write('secret.env', 'turn-start-secret\n');
    await recordTurnStart();
    await write('secret.env', 'edited-secret\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edited-secret\n'), path: 'secret.env' })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_revertible');
      expect(result.message).toContain('not covered by the turn-start snapshot');
    }
    // The live file is untouched and nothing was reindexed or stamped.
    expect(await readOrNull('secret.env')).toBe('edited-secret\n');
    expect(reindexActions).toEqual([]);

    // Force must NOT bypass the coverage gate — force is for the conflict
    // gate only; an uncovered path can never restore.
    const forced = await undoCheckpointEntry(db, { force: true, id: record.id }, undoDeps());
    expect(forced.ok).toBe(false);
    expect(await readOrNull('secret.env')).toBe('edited-secret\n');

    // Availability serves the SAME typed reason, per entry (fail-safe).
    const availability = await listCheckpointUndoAvailability(db, undoDeps(), THREAD);
    expect(availability.byCheckpointId[record.id]).toMatchObject({ restorable: false });
    const entry = availability.byCheckpointId[record.id];
    if (entry && entry.restorable === false) {
      expect(entry.reason).toContain('not covered by the turn-start snapshot');
    }
  });

  it('refuses a wrong-case journal path on a case-insensitive filesystem instead of deleting the real file', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async (ctx) => {
    // Runtime probe: this fixture only means anything where the filesystem
    // resolves differing case to the same file (macOS default APFS). On a
    // case-SENSITIVE fs the wrong-case journal path names a nonexistent file
    // and the scenario cannot occur — skip VISIBLY, never fake it.
    if (!(await isCaseInsensitiveFs(rootPath))) {
      ctx.skip();
      return;
    }
    await write('Src/Utils.txt', 'turn-start\n');
    await recordTurnStart();
    await write('Src/Utils.txt', 'edited\n');
    // `resolveWorkspaceWritePath` keeps the REQUESTED spelling, so a tool that
    // asked for "src/utils.txt" journals that — the git tree lookup is
    // case-sensitive and misses, which must refuse, not delete the real file.
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edited\n'), path: 'src/utils.txt' })
    );

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_revertible');
      expect(result.message).toContain('path-case mismatch');
    }
    // The real file, under its on-disk spelling, is untouched.
    expect(await readOrNull('Src/Utils.txt')).toBe('edited\n');
  });

  it('handles the production journal path shape (leading slash) end to end', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    // Production rows record NORMALIZED workspace paths ("/lead.txt" —
    // `resolveWorkspaceWritePath.workspacePath`); the shadow tree and the
    // restore seam are root-relative. The engine owns the translation — an
    // unstripped leading slash would throw out of the seam's path guard (and
    // would read every production row as uncovered under the coverage gate).
    await write('lead.txt', 'turn-start\n');
    await recordTurnStart();
    await write('lead.txt', 'edited\n');
    const record = await recordEditCheckpoint(
      db,
      journalInput({ afterHash: await hashOf('edited\n'), path: '/lead.txt' })
    );

    const availability = await listCheckpointUndoAvailability(db, undoDeps(), THREAD);
    expect(availability.byCheckpointId[record.id]).toEqual({ restorable: true });

    const result = await undoCheckpointEntry(db, { id: record.id }, undoDeps());
    expect(result.ok).toBe(true);
    expect(await readOrNull('lead.txt')).toBe('turn-start\n');
  });
});

describe('undoCheckpointRun', () => {
  it('restores a recursive child checkpoint and retains independent sibling work', async () => {
    const childThread =
      'thread-74da70cd-4f39-46de-81b3-56b7b5b1b416-b7a52f6c-7e72-4241-bf33-e5b9bbf1d93e-70950143-21e5-44b4-8aa0-b574d36ad961-55dbf797-1713-4fc6-b4e4-9e85f0453bb7';
    const childRun = 'recursive-child-run';
    await write('a.txt', 'User baseline');
    const before = await service.snapshot(handle, {
      kind: 'turn-start',
      runId: childRun,
      threadId: childThread,
    });
    await repository.insertSnapshot({
      commitOid: before.commitOid,
      kind: 'turn-start',
      rootId: ROOT_ID,
      rootPath: handle.rootPath,
      runId: childRun,
      threadId: childThread,
    });
    await write('a.txt', 'Child edit');
    const checkpoint = await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('Child edit'),
        runId: childRun,
        threadId: childThread,
      })
    );
    await write('sibling.txt', 'Independent sibling work');
    const availability = await listCheckpointUndoAvailability(db, undoDeps(), childThread);
    expect(availability.byCheckpointId[checkpoint.id]).toEqual({ restorable: true });
    const result = await undoCheckpointRun(db, { runId: childRun }, undoDeps());
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ ok: true });
    expect(await readOrNull('a.txt')).toBe('User baseline');
    expect(await readOrNull('sibling.txt')).toBe('Independent sibling work');
    const persisted = await db.query(
      'SELECT thread_id, reverted_at FROM brainstrike_assistant_edit_checkpoints WHERE id = $1',
      [checkpoint.id]
    );
    expect(persisted.rows[0]).toMatchObject({
      reverted_at: expect.anything(),
      thread_id: childThread,
    });
  });

  it('refuses child restoration over a later sibling edit without changing either journal', async () => {
    await write('a.txt', 'User baseline');
    const childThread =
      'thread-74da70cd-4f39-46de-81b3-56b7b5b1b416-b7a52f6c-7e72-4241-bf33-e5b9bbf1d93e-70950143-21e5-44b4-8aa0-b574d36ad961-55dbf797-1713-4fc6-b4e4-9e85f0453bb7';
    const childRun = 'child-restore-run';
    const snapshot = await service.snapshot(handle, {
      kind: 'turn-start',
      runId: childRun,
      threadId: childThread,
    });
    await repository.insertSnapshot({
      commitOid: snapshot.commitOid,
      kind: 'turn-start',
      rootId: ROOT_ID,
      rootPath: handle.rootPath,
      runId: childRun,
      threadId: childThread,
    });
    await write('a.txt', 'First child edit');
    const child = await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('First child edit'),
        runId: childRun,
        threadId: childThread,
      })
    );
    await write('a.txt', 'Later sibling edit');
    const sibling = await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('Later sibling edit'),
        runId: 'sibling-run',
        threadId: 'sibling-thread',
      })
    );
    const result = await undoCheckpointRun(db, { runId: childRun }, undoDeps());
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ code: 'conflict', ok: false });
    expect(await readOrNull('a.txt')).toBe('Later sibling edit');
    const rows = await db.query(
      'SELECT reverted_at FROM brainstrike_assistant_edit_checkpoints WHERE id IN ($1, $2) ORDER BY id',
      [child.id, sibling.id]
    );
    expect(rows.rows).toEqual([{ reverted_at: null }, { reverted_at: null }]);
    expect(reindexActions).toEqual([]);
  });

  it('restores the parent edits without erasing a child effect or independent user work', async () => {
    await write('a.txt', 'Parent baseline');
    await recordTurnStart();
    await write('a.txt', 'Parent effect');
    await recordEditCheckpoint(db, journalInput({ afterHash: await hashOf('Parent effect') }));
    await write('child.txt', 'Completed child effect');
    const child = await recordEditCheckpoint(
      db,
      journalInput({
        afterHash: await hashOf('Completed child effect'),
        beforeExisted: false,
        captureStatus: 'created',
        path: 'child.txt',
        resourceId: 'child-resource',
        runId: 'child-run',
        threadId: 'child-thread',
        toolCallId: 'child-write',
      })
    );
    await write('user.txt', 'Independent user edit');
    const restored = await undoCheckpointRun(db, { runId: RUN }, undoDeps());
    expect(restored.outcomes).toHaveLength(1);
    expect(restored.outcomes[0]?.ok).toBe(true);
    expect(await readOrNull('a.txt')).toBe('Parent baseline');
    expect(await readOrNull('child.txt')).toBe('Completed child effect');
    expect(await readOrNull('user.txt')).toBe('Independent user edit');
    expect(
      (
        await db.query(
          'SELECT reverted_at FROM brainstrike_assistant_edit_checkpoints WHERE id = $1',
          [child.id]
        )
      ).rows
    ).toEqual([{ reverted_at: null }]);
  });

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

  it('restores the SAME relative path in TWO roots independently (multi-root bar; no cross-root handled-path collapse)', {
    timeout: HEAVY_TIMEOUT_MS,
  }, async () => {
    // Second mounted root sharing the relative path `src/config.ts` with the
    // first. Keying handled paths by path ALONE collapses the two: the second
    // root's record finds "nothing pending", stamps reverted, and leaves its
    // file modified — a silent skip the multi-root bar forbids.
    const rootIdB = 'root-undo-b';
    const rootPathB = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-undo-root-b-'))
    );
    try {
      await db.query(
        `INSERT INTO roots (id, kind, display_name, path, status, created_at)
         VALUES ($1, 'path', 'Undo Project B', $2, 'live', $3)`,
        [rootIdB, rootPathB, new Date().toISOString()]
      );
      const handleB = await service.ensureShadowRepo({ path: rootPathB, rootId: rootIdB });

      await write('src/config.ts', 'a-turn-start\n');
      await fsPromises.mkdir(path.join(rootPathB, 'src'), { recursive: true });
      await fsPromises.writeFile(path.join(rootPathB, 'src/config.ts'), 'b-turn-start\n', 'utf8');
      await recordTurnStart();
      const { commitOid: startB } = await service.snapshot(handleB, {
        kind: 'turn-start',
        runId: RUN,
        threadId: THREAD,
      });
      await repository.insertSnapshot({
        commitOid: startB,
        kind: 'turn-start',
        rootId: rootIdB,
        rootPath: handleB.rootPath,
        runId: RUN,
        threadId: THREAD,
      });

      const base = Date.now();
      await write('src/config.ts', 'a-edited\n');
      await recordEditCheckpoint(
        db,
        journalInput({
          afterHash: await hashOf('a-edited\n'),
          occurredAt: new Date(base + 1000),
          path: 'src/config.ts',
          toolCallId: 'call-a',
        })
      );
      await fsPromises.writeFile(path.join(rootPathB, 'src/config.ts'), 'b-edited\n', 'utf8');
      await recordEditCheckpoint(
        db,
        journalInput({
          afterHash: await hashOf('b-edited\n'),
          occurredAt: new Date(base + 2000),
          path: 'src/config.ts',
          rootId: rootIdB,
          toolCallId: 'call-b',
        })
      );

      const result = await undoCheckpointRun(db, { runId: RUN }, undoDeps());
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes.every((outcome) => outcome.ok)).toBe(true);
      // BOTH roots' files are back at turn start — per-root outcomes, never a
      // cross-root skip.
      expect(await readOrNull('src/config.ts')).toBe('a-turn-start\n');
      expect(await fsPromises.readFile(path.join(rootPathB, 'src/config.ts'), 'utf8')).toBe(
        'b-turn-start\n'
      );
      // One restore reindex per root.
      const restores = reindexActions.filter((action) => action.kind === 'restore');
      expect(restores.map((action) => action.rootId).sort()).toEqual([ROOT_ID, rootIdB].sort());
    } finally {
      await fsPromises.rm(rootPathB, { force: true, recursive: true });
    }
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
