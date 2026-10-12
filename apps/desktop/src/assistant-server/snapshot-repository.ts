/**
 * Row CRUD for `brainstrike_workspace_snapshots` (BST-1164, W7 T1) — the
 * shadow-git snapshot ledger created by migration 081 and mirrored by the
 * app-shell renderer bootstrap.
 *
 * STORAGE PRIMITIVES ONLY, by charter: insert, list-by-thread, list roots for
 * a thread, latest-per-(thread,root), and delete-by-thread. Turn-boundary
 * resolution (e.g. `resolveTurnBounds`) is T2's to build ON TOP of these —
 * it is deliberately absent here, not forgotten.
 *
 * Takes the same injected `MainQueryHandle` seam the rewind repository uses
 * (db-main's handle in production, a bare PGlite in tests).
 * This module never creates the table: migration 081 (both runners) and the
 * renderer bootstrap mirror own the DDL.
 *
 * Ids are app-side uuidv7 (time-sortable; the sync-groundwork ruling), NOT a
 * DB default — migration 080's caller-supplied-text-PK convention, and the
 * caller gets the id without a round trip. `created_at` is DB-stamped and
 * read back with an explicit `::text` cast so the microsecond fraction
 * survives (rewind-repository precedent — never route it through a JS
 * `Date`).
 *
 * NO SILENT FALLBACKS: a stored `kind` outside the closed vocabulary throws
 * on read (a stale literal must never become a permanently skipped row), and
 * a malformed commit oid is refused on insert.
 *
 * FAILED-CAPTURE ROWS (T2): a snapshot capture that FAILED is still recorded,
 * as a row whose `commit_oid` is {@link FAILED_SNAPSHOT_CAPTURE_OID} (git's
 * all-zero null oid — a valid oid SHAPE naming no object, so it passes the
 * insert validation while remaining structurally unresolvable). This is the
 * durable failed-capture marker the plan's carried ruling requires: the run
 * proceeds, but the turn's changeset must render an honest capture-failed
 * error and rewind must refuse the range — so EVERY reader of this ledger
 * (T2's view resolver, T3's rewind range resolution) MUST check
 * {@link isFailedSnapshotCaptureOid} before treating a row's oid as a real
 * commit. Never hand a sentinel oid to git.
 */

import { randomBytes } from 'node:crypto';
import { WORKSPACE_SNAPSHOTS_TABLE } from '@brainstrike/assistant-contract';
import type { MainQueryHandle } from './main-query-handle';
import { assertValidOid } from './snapshot-git';
import type { SnapshotKind } from './snapshot-service';

const SNAPSHOT_KINDS: readonly SnapshotKind[] = ['pre-revert', 'turn-end', 'turn-start'];

/**
 * Durable failed-capture marker (see the module doc comment): git's all-zero
 * null oid, stored in `commit_oid` when a snapshot capture failed. It names
 * no object by construction, so it can never be confused with a real commit.
 */
export const FAILED_SNAPSHOT_CAPTURE_OID = '0'.repeat(40);

export function isFailedSnapshotCaptureOid(oid: string): boolean {
  return oid === FAILED_SNAPSHOT_CAPTURE_OID;
}

export interface WorkspaceSnapshotRow {
  readonly commitOid: string;
  /** Full-precision `::text` timestamp — never routed through a JS `Date`. */
  readonly createdAt: string;
  readonly id: string;
  readonly kind: SnapshotKind;
  readonly rootId: string;
  readonly rootPath: string;
  readonly runId: string | null;
  readonly threadId: string;
}

export interface InsertWorkspaceSnapshotInput {
  readonly commitOid: string;
  readonly kind: SnapshotKind;
  readonly rootId: string;
  /** Canonicalized root path at snapshot time (`ShadowRepoHandle.rootPath`). */
  readonly rootPath: string;
  readonly runId?: string | undefined;
  readonly threadId: string;
}

export interface ThreadSnapshotRoot {
  readonly rootId: string;
  /** The most recently recorded path for this root within the thread. */
  readonly rootPath: string;
}

/** One thread's deleted snapshot commits, grouped per root (GC input). */
export interface DeletedThreadSnapshots {
  readonly commitOids: readonly string[];
  readonly rootId: string;
}

const UUID_V7_MAX_TIMESTAMP_MS = 2 ** 48;
const UUID_V7_COUNTER_MAX = 0xf_ff;

let monotonicMs = -1;
let monotonicCounter = 0;

/**
 * App-side UUIDv7 (RFC 9562): 48-bit millisecond timestamp, version and
 * variant bits, a 12-bit per-millisecond MONOTONIC counter in rand_a (RFC
 * 9562 §6.2 method 2), and 62 random bits in rand_b. Postgres 18's
 * `uuidv7()` exists, but the id is minted here so the caller owns it before
 * the INSERT round trip — and so ids from this process sort in MINT ORDER
 * even within one millisecond, which is what makes `ORDER BY created_at, id`
 * deterministic when PGlite stamps two snapshot rows with a tied timestamp
 * (empirically observed: consecutive inserts can tie `NOW()`).
 */
export function generateWorkspaceSnapshotId(nowMs = Date.now()): string {
  if (!(Number.isSafeInteger(nowMs) && nowMs >= 0 && nowMs < UUID_V7_MAX_TIMESTAMP_MS)) {
    throw new RangeError(`uuidv7 timestamp out of range: ${nowMs}`);
  }
  let ms = nowMs;
  if (ms === monotonicMs) {
    monotonicCounter += 1;
    if (monotonicCounter > UUID_V7_COUNTER_MAX) {
      // 4097 ids in one millisecond: roll into the next millisecond (RFC 9562
      // "increment timestamp" guidance) rather than wrapping the counter,
      // which would break the mint-order sort this generator exists for.
      ms += 1;
      if (ms >= UUID_V7_MAX_TIMESTAMP_MS) {
        throw new RangeError(`uuidv7 timestamp overflow after counter rollover: ${ms}`);
      }
      monotonicMs = ms;
      monotonicCounter = 0;
    }
  } else {
    monotonicMs = ms;
    monotonicCounter = 0;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((monotonicCounter >> 8) & 0x0f);
  bytes[7] = monotonicCounter & 0xff;
  bytes[8] = 0x80 | (bytes.readUInt8(8) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface SnapshotSqlRow {
  commitOid: string;
  createdAt: string;
  id: string;
  kind: string;
  rootId: string;
  rootPath: string;
  runId: string | null;
  threadId: string;
}

function assertSnapshotKind(value: string, id: string): SnapshotKind {
  if ((SNAPSHOT_KINDS as readonly string[]).includes(value)) {
    return value as SnapshotKind;
  }
  // The CHECK constraint (migration 081) makes this unreachable for rows this
  // repository wrote; reaching it means schema and code drifted. Throwing is
  // the point — a quietly skipped row would be a silent capture-history hole.
  throw new Error(
    `workspace snapshot "${id}" has unknown kind "${value}" — schema and repository vocabulary drifted`
  );
}

function toRow(row: SnapshotSqlRow): WorkspaceSnapshotRow {
  return {
    commitOid: row.commitOid,
    createdAt: row.createdAt,
    id: row.id,
    kind: assertSnapshotKind(row.kind, row.id),
    rootId: row.rootId,
    rootPath: row.rootPath,
    runId: row.runId,
    threadId: row.threadId,
  };
}

const ROW_SELECT = `
  id AS "id",
  thread_id AS "threadId",
  run_id AS "runId",
  root_id AS "rootId",
  root_path AS "rootPath",
  commit_oid AS "commitOid",
  kind AS "kind",
  created_at::text AS "createdAt"
`;

export interface SnapshotRepository {
  /** Startup-GC ring trim (BST-1164 T4): hard-delete specific ledger rows.
   * Returns the actually-deleted count (RETURNING-based — PGlite never sets
   * `affectedRows`). */
  deleteByIds(ids: readonly string[]): Promise<number>;
  deleteForThread(threadId: string): Promise<readonly DeletedThreadSnapshots[]>;
  insertSnapshot(input: InsertWorkspaceSnapshotInput): Promise<WorkspaceSnapshotRow>;
  latestSnapshotFor(
    threadId: string,
    rootId: string,
    kind?: SnapshotKind
  ): Promise<WorkspaceSnapshotRow | null>;
  rootsForThread(threadId: string): Promise<readonly ThreadSnapshotRoot[]>;
  snapshotsForThread(threadId: string): Promise<readonly WorkspaceSnapshotRow[]>;
}

/** The factory main.ts threads to the changes/assistant-server seams (T1). */
export function createSnapshotRepository(db: MainQueryHandle): SnapshotRepository {
  async function insertSnapshot(
    input: InsertWorkspaceSnapshotInput
  ): Promise<WorkspaceSnapshotRow> {
    assertValidOid(input.commitOid, 'insertSnapshot "commitOid"');
    const id = generateWorkspaceSnapshotId();
    const result = await db.query<SnapshotSqlRow>(
      `INSERT INTO ${WORKSPACE_SNAPSHOTS_TABLE}
         (id, thread_id, run_id, root_id, root_path, commit_oid, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${ROW_SELECT}`,
      [
        id,
        input.threadId,
        input.runId ?? null,
        input.rootId,
        input.rootPath,
        input.commitOid,
        input.kind,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('workspace snapshot INSERT returned no row');
    }
    return toRow(row);
  }

  async function snapshotsForThread(threadId: string): Promise<readonly WorkspaceSnapshotRow[]> {
    const result = await db.query<SnapshotSqlRow>(
      `SELECT ${ROW_SELECT}
         FROM ${WORKSPACE_SNAPSHOTS_TABLE}
        WHERE thread_id = $1
        ORDER BY created_at ASC, id ASC`,
      [threadId]
    );
    return result.rows.map(toRow);
  }

  async function latestSnapshotFor(
    threadId: string,
    rootId: string,
    kind?: SnapshotKind
  ): Promise<WorkspaceSnapshotRow | null> {
    const params: unknown[] = [threadId, rootId];
    let kindFilter = '';
    if (kind !== undefined) {
      params.push(kind);
      kindFilter = 'AND kind = $3';
    }
    const result = await db.query<SnapshotSqlRow>(
      `SELECT ${ROW_SELECT}
         FROM ${WORKSPACE_SNAPSHOTS_TABLE}
        WHERE thread_id = $1 AND root_id = $2 ${kindFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      params
    );
    const row = result.rows[0];
    return row ? toRow(row) : null;
  }

  async function rootsForThread(threadId: string): Promise<readonly ThreadSnapshotRoot[]> {
    const result = await db.query<{ rootId: string; rootPath: string }>(
      `SELECT DISTINCT ON (root_id)
              root_id AS "rootId",
              root_path AS "rootPath"
         FROM ${WORKSPACE_SNAPSHOTS_TABLE}
        WHERE thread_id = $1
        ORDER BY root_id ASC, created_at DESC, id DESC`,
      [threadId]
    );
    return result.rows.map((row) => ({ rootId: row.rootId, rootPath: row.rootPath }));
  }

  async function deleteForThread(threadId: string): Promise<readonly DeletedThreadSnapshots[]> {
    // PGlite never sets `affectedRows`; RETURNING is the honest row count AND
    // the GC input (which shadow commits just lost their ledger anchor).
    const result = await db.query<{ commitOid: string; rootId: string }>(
      `DELETE FROM ${WORKSPACE_SNAPSHOTS_TABLE}
        WHERE thread_id = $1
        RETURNING root_id AS "rootId", commit_oid AS "commitOid"`,
      [threadId]
    );
    const byRoot = new Map<string, string[]>();
    for (const row of result.rows) {
      const oids = byRoot.get(row.rootId);
      if (oids) {
        oids.push(row.commitOid);
      } else {
        byRoot.set(row.rootId, [row.commitOid]);
      }
    }
    return [...byRoot.entries()]
      .map(([rootId, commitOids]) => ({ commitOids, rootId }))
      .sort((a, b) => a.rootId.localeCompare(b.rootId));
  }

  async function deleteByIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await db.query<{ id: string }>(
      `DELETE FROM ${WORKSPACE_SNAPSHOTS_TABLE}
        WHERE id = ANY($1)
        RETURNING id AS "id"`,
      [ids]
    );
    return result.rows.length;
  }

  return {
    deleteByIds,
    deleteForThread,
    insertSnapshot,
    latestSnapshotFor,
    rootsForThread,
    snapshotsForThread,
  };
}
