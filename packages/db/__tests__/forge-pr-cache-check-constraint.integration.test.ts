/**
 * The `brainstrike_forge_prs` ROW-SHAPE CHECK constraint (BST-1391, W4),
 * exercised against a REAL, fully-migrated PGlite database.
 *
 * Was migration-110's suite, and it needed no rewriting beyond this comment and
 * its name: it already ran against `createMigratedTestDb` rather than against
 * one chain step, and every case is behaviour. The schema declares that a row is
 * EITHER a
 * "PR" observation (every PR-specific column populated) OR an observed-
 * ABSENCE ("none") observation (every PR-specific column NULL) —
 * `review_decision` sits outside that group and is always independently
 * nullable. The CHECK enforces the all-or-nothing invariant so a partially-
 * populated row can never exist; this file is the first thing that actually
 * INSERTs against it and proves the constraint fires (and doesn't) exactly
 * where the migration comment claims.
 *
 * Uses `createMigratedTestDb` (the shared snapshot-restore helper): the subject
 * is the resulting SCHEMA's behaviour, not how it was constructed.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db';

const INSERT_SQL = `
  INSERT INTO brainstrike_forge_prs (
    repo_common_dir, branch, number, url, title, state,
    is_draft, review_decision, checks_json, head_sha, observed_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
`;

const OBSERVED_AT = '2026-08-24T00:00:00.000Z';

describe('brainstrike_forge_prs CHECK constraint (real PGlite)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('rejects a half-populated row (number set, url NULL)', async () => {
    // Observed against a real PGlite 0.5.x: `new row for relation
    // "brainstrike_forge_prs" violates check constraint
    // "brainstrike_forge_prs_check"`.
    await expect(
      db.query(INSERT_SQL, [
        '/repos/widgets/.git',
        'feature/half',
        // number set, every other PR-specific column left NULL — the exact
        // half-populated shape the migration comment says can never exist.
        42,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        OBSERVED_AT,
      ])
    ).rejects.toThrow(/check constraint/i);
  });

  it('accepts an all-NULL observed-absence ("none") row', async () => {
    await db.query(INSERT_SQL, [
      '/repos/widgets/.git',
      'feature/none',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      OBSERVED_AT,
    ]);

    const stored = await db.query<{ number: number | null; observed_at: string }>(
      'SELECT number, observed_at FROM brainstrike_forge_prs WHERE repo_common_dir = $1 AND branch = $2',
      ['/repos/widgets/.git', 'feature/none']
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.number).toBeNull();
  });

  it('accepts a fully-populated PR row', async () => {
    await db.query(INSERT_SQL, [
      '/repos/widgets/.git',
      'feature/full',
      42,
      'https://github.com/acme/widgets/pull/42',
      'Widget it',
      'open',
      false,
      'APPROVED',
      JSON.stringify([{ conclusion: 'success', name: 'unit', url: null }]),
      'sha-1',
      OBSERVED_AT,
    ]);

    const stored = await db.query<{ number: number; url: string }>(
      'SELECT number, url FROM brainstrike_forge_prs WHERE repo_common_dir = $1 AND branch = $2',
      ['/repos/widgets/.git', 'feature/full']
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.number).toBe(42);
    expect(stored.rows[0]?.url).toBe('https://github.com/acme/widgets/pull/42');
  });
});
