/**
 * Shared fixtures for the Conversation Rewind suites (BST-1115 W5 T3; snapshot
 * engine BST-1164 W7 T3).
 *
 * REAL PGlite + REAL filesystem + REAL shadow git (the production
 * `execFileSnapshotGitRunner`). Every relation here comes from the migration
 * chain: `mastra_messages` and `mastra_threads` from 117, the run header from
 * 118. This fixture used to stand up its own copy of the run table because
 * that DDL was renderer-lazy bootstrap-only — a THIRD schema authority behind
 * the repository mirror BST-1651 retired, and one whose copy silently dropped
 * the `thread_id` foreign key the real table has carried since it shipped. So
 * a rewind fixture could anchor runs on a thread that did not exist, which
 * production has never allowed.
 *
 * Runs therefore need a `mastra_threads` parent now. `createRewindFixture`
 * seeds `THREAD_ID`; a test using any other thread must `insertThread` it
 * first, exactly as the app must create the thread before it can run on it.
 *
 * Turn boundaries are seeded the way T2's run lifecycle records them: a
 * `turn-start` snapshot of every root's CURRENT disk state, committed to the
 * shadow repo and inserted into the `brainstrike_workspace_snapshots` ledger
 * under the turn's anchor run id (`seedTurnStartSnapshots`). Tests then write
 * the turn's edits DIRECTLY to disk — there is no journal row anywhere in
 * these fixtures, which is the point of the engine swap: a direct `fs` write
 * is indistinguishable from a tool edit.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import type { CheckpointReindexAction } from '../../assistant-server/checkpoint-reindex-deps';
import type { MainQueryHandle } from '../../assistant-server/main-query-handle';
import type { RewindServiceDeps } from '../../assistant-server/rewind-service';
import {
  createSnapshotRepository,
  type SnapshotRepository,
} from '../../assistant-server/snapshot-repository';
import {
  createSnapshotService,
  type SnapshotService,
} from '../../assistant-server/snapshot-service';
import { execFixtureGit, fixtureSnapshotGitRunner } from './_git-fixture-environment';

export const THREAD_ID = 'thread-rewind';
export const RESOURCE_ID = 'workspace-rewind';

export interface RewindFixture {
  readonly db: PGlite;
  readonly rootPaths: Record<string, string>;
}

const tempDirs: string[] = [];

export async function makeTempDir(prefix = 'bs-rewind-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function makeGitRepo(prefix = 'bs-rewind-repo-'): Promise<string> {
  const dir = await makeTempDir(prefix);
  await execFixtureGit(['init', '--quiet'], { cwd: dir });
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fsPromises.rm(dir, { force: true, recursive: true }))
  );
}

/** The Mastra thread row every run and message in this fixture hangs off. */
export async function insertThread(db: PGlite, threadId: string): Promise<void> {
  await db.query(
    `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, NOW(), NOW())`,
    [threadId, RESOURCE_ID, `Thread ${threadId}`]
  );
}

/**
 * Fresh in-memory database with the migrated schema, the fixture's thread, and
 * one `roots` row per supplied root.
 */
export async function createRewindFixture(
  roots: Readonly<Record<string, string>>,
  databaseName: string
): Promise<RewindFixture> {
  const db = await wasmLoader.createPGlite(`memory://${databaseName}`);
  await migrate(db);
  await insertThread(db, THREAD_ID);
  let created = 0;
  for (const [rootId, rootPath] of Object.entries(roots)) {
    created += 1;
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES ($1, 'path', $2, $3, 'live', $4)`,
      [rootId, `Root ${rootId}`, rootPath, new Date(created * 1000).toISOString()]
    );
  }
  return { db, rootPaths: { ...roots } };
}

/** Disconnect a root exactly the way the app does (status flip, row kept). */
export async function disconnectRoot(db: PGlite, rootId: string): Promise<void> {
  await db.query(`UPDATE roots SET status = 'disconnected' WHERE id = $1`, [rootId]);
}

export async function insertMessage(
  db: PGlite,
  args: { createdAt: string; id: string; role?: string; threadId?: string }
): Promise<void> {
  await db.query(
    `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
     VALUES ($1, $2, '{}'::jsonb, $3, 'text', $4::timestamptz, $5)`,
    [args.id, args.threadId ?? THREAD_ID, args.role ?? 'user', args.createdAt, RESOURCE_ID]
  );
}

/**
 * `status` defaults to `'completed'` — a finished turn is what almost every
 * rewind test needs. Pass `'running'` to seed the in-flight run that the
 * `run-in-flight` gate refuses on.
 *
 * `completedAt` is the range anchor (`resolveRewindRunRange`): a run that
 * finished BEFORE the target message was sent is not part of that message's
 * rewind. Omitting it seeds a run with no completion stamp, which in production
 * only ever means "still in flight" — the `run-in-flight` gate refuses those
 * before a range is ever resolved, so a test that omits it is describing a
 * thread the gate would reject.
 */
export async function insertRun(
  db: PGlite,
  args: {
    completedAt?: string;
    id: string;
    startedAt: string;
    status?: 'cancelled' | 'completed' | 'failed' | 'running';
    threadId?: string;
    /** The run↔turn link (BST-1163). Omitted seeds a legacy NULL-link row. */
    turnMessageId?: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO brainstrike_assistant_thread_runs
       (id, resource_id, thread_id, provider, model, runtime_kind, status,
        started_at, completed_at, created_at, updated_at, turn_message_id)
     VALUES ($1, $2, $3, 'anthropic', 'test-model', 'hosted', $5,
             $4::timestamptz, $6::timestamptz, $4::timestamptz, $4::timestamptz, $7)`,
    [
      args.id,
      RESOURCE_ID,
      args.threadId ?? THREAD_ID,
      args.startedAt,
      args.status ?? 'completed',
      args.completedAt ?? null,
      args.turnMessageId ?? null,
    ]
  );
}

export function absolutePathFor(rootPath: string, workspacePath: string): string {
  return path.join(rootPath, workspacePath.replace(/^\/+/, ''));
}

export async function writeDiskFile(
  rootPath: string,
  workspacePath: string,
  content: string
): Promise<void> {
  const absolute = absolutePathFor(rootPath, workspacePath);
  await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
  await fsPromises.writeFile(absolute, content, 'utf8');
}

export async function readDiskFile(
  rootPath: string,
  workspacePath: string
): Promise<string | null> {
  try {
    return await fsPromises.readFile(absolutePathFor(rootPath, workspacePath), 'utf8');
  } catch {
    return null;
  }
}

export interface SnapshotHarness {
  readonly repository: SnapshotRepository;
  readonly service: SnapshotService;
}

/** Real shadow-git snapshot service + ledger repository over the fixture DB.
 * The snapshots base dir is a temp dir cleaned by `cleanupTempDirs`. */
export async function createSnapshotHarness(db: PGlite): Promise<SnapshotHarness> {
  const snapshotsBaseDir = await makeTempDir('bs-rewind-snapbase-');
  return {
    repository: createSnapshotRepository(db as unknown as MainQueryHandle),
    service: createSnapshotService({
      runner: fixtureSnapshotGitRunner,
      snapshotsBaseDir,
    }),
  };
}

/** The full `RewindServiceDeps` a files-mode apply/redo takes. */
export function rewindDeps(harness: SnapshotHarness, probe: ReindexProbe): RewindServiceDeps {
  return {
    reindex: probe.reindex,
    snapshotRepository: harness.repository,
    snapshotService: harness.service,
  };
}

/**
 * Record the turn boundary the way T2's run lifecycle does: one `turn-start`
 * snapshot per root of the root's CURRENT on-disk state, committed to the
 * shadow repo and inserted into the ledger under `runId` (the turn's anchor
 * run). Call BEFORE writing the turn's own edits to disk.
 */
export async function seedTurnStartSnapshots(
  harness: SnapshotHarness,
  fixture: RewindFixture,
  args: { readonly rootIds?: readonly string[]; readonly runId: string; readonly threadId?: string }
): Promise<void> {
  const threadId = args.threadId ?? THREAD_ID;
  const rootIds = args.rootIds ?? Object.keys(fixture.rootPaths).sort();
  for (const rootId of rootIds) {
    const rootPath = fixture.rootPaths[rootId];
    if (!rootPath) {
      throw new Error(`test fixture has no root "${rootId}"`);
    }
    const handle = await harness.service.ensureShadowRepo({ path: rootPath, rootId });
    const { commitOid } = await harness.service.snapshot(handle, {
      kind: 'turn-start',
      runId: args.runId,
      threadId,
    });
    await harness.repository.insertSnapshot({
      commitOid,
      kind: 'turn-start',
      rootId,
      rootPath: handle.rootPath,
      runId: args.runId,
      threadId,
    });
  }
}

export interface ReindexProbe {
  readonly calls: CheckpointReindexAction[];
  /**
   * Non-empty ⇒ two reverts were in flight at once. The plan MUST run in one
   * sequential pass; `Promise.all` over different files overlaps here
   * deterministically, which is exactly the mutation this catches.
   */
  readonly overlaps: string[];
  readonly reindex: (action: CheckpointReindexAction) => Promise<void>;
}

export function createReindexProbe(): ReindexProbe {
  const calls: CheckpointReindexAction[] = [];
  const overlaps: string[] = [];
  let inFlight = 0;
  return {
    calls,
    overlaps,
    reindex: async (action: CheckpointReindexAction): Promise<void> => {
      calls.push(action);
      inFlight += 1;
      if (inFlight > 1) {
        overlaps.push(action.workspacePath);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    },
  };
}

export function restoredContents(probe: ReindexProbe): string[] {
  return probe.calls
    .filter(
      (action): action is Extract<CheckpointReindexAction, { kind: 'restore' }> =>
        action.kind === 'restore'
    )
    .map((action) => action.content);
}
