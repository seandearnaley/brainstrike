import {
  type ManagedWorktreeCreator,
  type ManagedWorktreeSetupStatus,
  WORKTREE_LEDGER_TABLE,
} from '@brainstrike/types';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResetTables } from '../src/reset-table-registry.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_worktrees';
const ALL_CREATORS = ['agent', 'user'] as const satisfies readonly ManagedWorktreeCreator[];
const ALL_SETUP_STATUSES = [
  'failed',
  'none',
  'skipped',
  'succeeded',
] as const satisfies readonly ManagedWorktreeSetupStatus[];

function assertUnionFullyEnumerated<Union>() {
  return <Values extends readonly Union[]>(
    _values: Values & (Exclude<Union, Values[number]> extends never ? unknown : never)
  ): void => undefined;
}
assertUnionFullyEnumerated<ManagedWorktreeCreator>()(ALL_CREATORS);
assertUnionFullyEnumerated<ManagedWorktreeSetupStatus>()(ALL_SETUP_STATUSES);

/**
 * Runtime behaviour of the managed worktree ledger.
 *
 * Was migration-109's suite. Dropped: "creates the ledger table", pinned by the
 * catalog readback in __tests__/fixtures/schema-catalog.snapshot.txt; "adds
 * setup_reason to an upgraded profile without losing ledger rows", which is an
 * old-schema upgrade path ADR-0020 explicitly does not build; "rolls back
 * cleanly", because ADR-0020 does not build rollback; and the separate "both
 * runners invariant" suite, because the collapse leaves ONE runner applying one
 * DDL, so a table can no longer exist in one runner and not the other.
 *
 * Kept: the UNIQUE path, both closed CHECK vocabularies, the nullable
 * branch/thread, the reset registration, and -- the reason the TypeScript unions
 * are enumerated above rather than hard-coded -- that every value the TS unions
 * admit is a value the DB CHECKs accept. That TS-to-DB parity is NOT in the
 * fixture, which records the CHECK's SQL text and nothing about the unions.
 */
describe('worktree ledger', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  function insertWorktree(
    id: string,
    path: string,
    createdBy = 'user',
    setupStatus = 'none'
  ): Promise<unknown> {
    return db.query(
      `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
       VALUES ($1, '/repo/.git', $2, 'main', $3, $4)`,
      [id, path, createdBy, setupStatus]
    );
  }

  it('is the table the shipped WORKTREE_LEDGER_TABLE constant names', async () => {
    expect(WORKTREE_LEDGER_TABLE).toBe(TABLE);

    // Not a tautology against the literal: this proves the constant names a
    // table the shipped schema actually builds.
    const relation = await db.query<{ regclass: string | null }>(
      'SELECT to_regclass($1)::text AS regclass',
      [WORKTREE_LEDGER_TABLE]
    );
    expect(relation.rows[0]?.regclass).toBe(WORKTREE_LEDGER_TABLE);
  });

  it('enforces a UNIQUE path so one directory can never have two ledger rows', async () => {
    await insertWorktree('w-1', '/wt/alpha');

    await expect(insertWorktree('w-2', '/wt/alpha')).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects a created_by outside the closed set', async () => {
    await expect(insertWorktree('w-3', '/wt/beta', 'robot')).rejects.toThrow(/check constraint/i);
  });

  it('rejects a setup_status outside the closed set', async () => {
    await expect(insertWorktree('w-4', '/wt/gamma', 'user', 'maybe')).rejects.toThrow(
      /check constraint/i
    );
  });

  it('accepts every created_by and setup_status represented by the TypeScript unions', async () => {
    for (const creator of ALL_CREATORS) {
      await insertWorktree(`w-creator-${creator}`, `/wt/creator-${creator}`, creator);
    }
    for (const setupStatus of ALL_SETUP_STATUSES) {
      await insertWorktree(
        `w-setup-${setupStatus}`,
        `/wt/setup-${setupStatus}`,
        'user',
        setupStatus
      );
    }

    const rows = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM ${TABLE}`
    );
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(ALL_CREATORS.length + ALL_SETUP_STATUSES.length);
  });

  it('allows a NULL branch (a detached worktree) and a NULL thread', async () => {
    await db.query(
      `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
       VALUES ('w-5', '/repo/.git', '/wt/detached', 'origin/main', 'user', 'none')`
    );

    const rows = await db.query<{ branch: string | null; thread_id: string | null }>(
      `SELECT branch, thread_id FROM ${TABLE} WHERE id = 'w-5'`
    );
    expect(rows.rows[0]).toEqual({ branch: null, thread_id: null });
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});
