/**
 * A migration that fails with an integrity SQLSTATE must reach the caller with that SQLSTATE
 * still readable (BST-1870). The desktop DB host classifies boot failures by SQLSTATE through
 * the `cause` chain; `runMigrations` used to flatten the thrown error into a string and
 * `migrate()` rebuilt a plain `Error`, so a real XX001/XX002 during migration was never
 * recognized. These run the REAL `runMigrations` → `migrate` path against a real PGlite whose
 * last migration raises `XX001`.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customMigrations, runMigrations } from '../src/drizzle/migrate.js';
import { migrate } from '../src/migrations/bootstrap.js';

const MIGRATION_RUN_TIMEOUT_MS = 60_000;
const MAX_CAUSE_DEPTH = 5;
const PROBE_NAME = '9999_integrity_probe';

function readSqlstateFromCauseChain(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}

describe('migration failures keep the original error as cause', () => {
  let db: PGlite;

  // One database for both tests: the first run applies every shipped migration, so the second
  // reaches the failing probe straight away.
  beforeAll(() => {
    db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
    customMigrations.push({
      hash: 'integrity-probe-ledger-key',
      name: PROBE_NAME,
      sql: "DO $$ BEGIN RAISE EXCEPTION 'integrity probe' USING ERRCODE = 'data_corrupted'; END $$",
      version: '9999',
    });
  });

  afterAll(async () => {
    customMigrations.pop();
    await db.close();
  });

  it(
    'runMigrations returns the thrown error next to the unchanged message string',
    async () => {
      const result = await runMigrations(db);

      expect(result.success).toBe(false);
      expect(result.error).toBe(`Migration "${PROBE_NAME}" failed: integrity probe`);
      expect(readSqlstateFromCauseChain(result.cause)).toBe('XX001');
    },
    MIGRATION_RUN_TIMEOUT_MS
  );

  it(
    'migrate() throws the same message with the original error as cause',
    async () => {
      const failure = await migrate(db).then(
        () => null,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(`Migration "${PROBE_NAME}" failed: integrity probe`);
      expect(readSqlstateFromCauseChain(failure)).toBe('XX001');
    },
    MIGRATION_RUN_TIMEOUT_MS
  );
});
