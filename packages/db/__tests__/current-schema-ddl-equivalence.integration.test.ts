import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { splitMigrationStatements } from '../src/drizzle/migrate.js';
import { migrate } from '../src/migrations/bootstrap.js';
import {
  dumpRowCounts,
  dumpSchema,
  dumpSeedData,
  MIGRATION_LEDGER_TABLES,
} from '../src/schema-snapshot/introspect.js';
import { TEST_ENGINE_EXTENSIONS } from './helpers/migrated-test-db.js';

/**
 * Proves `src/migrations/current-schema.sql` constructs exactly the database
 * the real migration chain constructs.
 *
 * This is the acceptance gate for collapsing the incremental chain into one
 * current-schema DDL (ADR-0020): the product is greenfield, so the chain's only
 * remaining job is to build the current schema, and a single DDL may replace it
 * if and only if the result is indistinguishable.
 *
 * Both sides boot a COLD, EMPTY cluster and are compared on catalog readback,
 * not on the SQL that produced them, so a default Postgres rewrote or an index
 * parameter that silently fell back to its default shows up as a diff.
 *
 * Deliberately NOT snapshot-restored (`createMigratedTestDb`): the subject is
 * schema construction itself, so it must run from initdb for real.
 */

const CURRENT_SCHEMA_DDL = fileURLToPath(
  new URL('../src/migrations/current-schema.sql', import.meta.url)
);

/**
 * The runner owns its own ledger (`ensureMigrationsTable`), and WHICH migrations
 * ran is exactly what a collapse changes on purpose, so ledger rows and the
 * ledger's own table are compared by neither side. Everything else is compared
 * in full.
 */
function withoutLedger(dump: string): string {
  const ledgerPattern = new RegExp(MIGRATION_LEDGER_TABLES.join('|'));
  return (
    dump
      .split('\n')
      .filter((line) => !ledgerPattern.test(line))
      // Section headers carry pre-filter counts, which the ledger lines above
      // would make disagree; the section bodies are the comparison.
      .filter((line) => !line.startsWith('-- ========'))
      .join('\n')
  );
}

interface Dumps {
  readonly data: string;
  readonly rowCounts: string;
  readonly schema: string;
}

async function dumpAll(db: PGlite): Promise<Dumps> {
  return {
    data: withoutLedger(await dumpSeedData(db)),
    rowCounts: withoutLedger(await dumpRowCounts(db)),
    schema: withoutLedger(await dumpSchema(db)),
  };
}

async function buildFromMigrationChain(): Promise<Dumps> {
  const db = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
  try {
    await migrate(db);
    return await dumpAll(db);
  } finally {
    await db.close();
  }
}

async function buildFromCurrentSchemaDdl(): Promise<Dumps> {
  const db = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
  try {
    const sql = await readFile(CURRENT_SCHEMA_DDL, 'utf-8');
    // The production statement splitter, so a statement that only parses
    // because of how it was split cannot pass here and fail at boot.
    for (const statement of splitMigrationStatements(sql)) {
      await db.query(statement);
    }
    return await dumpAll(db);
  } finally {
    await db.close();
  }
}

describe('current-schema DDL equivalence', () => {
  it('builds the same schema, row counts and seed rows as the migration chain', async () => {
    const [chain, ddl] = await Promise.all([
      buildFromMigrationChain(),
      buildFromCurrentSchemaDdl(),
    ]);

    // Schema first: a difference here explains any difference below, and the
    // data comparison's masking is derived from the schema, so an equal schema
    // is what makes the data comparison trustworthy.
    expect(ddl.schema).toBe(chain.schema);
    expect(ddl.rowCounts).toBe(chain.rowCounts);
    expect(ddl.data).toBe(chain.data);
  }, 120_000);

  it('covers the schema surface a collapse could silently drop', async () => {
    const chain = await buildFromMigrationChain();

    // Guards the guard: if the dumper stopped reporting a section, the
    // equivalence assertion above would compare two empty strings and pass.
    // These are the exact surfaces the collapse was required to preserve.
    expect(chain.schema).toContain('extension vector');
    expect(chain.schema).toContain('extension pg_textsearch');
    expect(chain.schema).toContain('extension pg_trgm');
    // Generated tsvector columns (migrations 019/034).
    expect(chain.schema).toMatch(/column file_chunks\.\d+\.content_tsvector .*generated=s/);
    // The job-queue claim index (migrations 007/008).
    expect(chain.schema).toContain('CREATE INDEX idx_job_queue_state_run_at');
    // Vector index access method (migration 067).
    expect(chain.schema).toContain('am=hnsw');
    // Dimensionless embedding column (migrations 010/014).
    expect(chain.schema).toMatch(/column file_chunks\.\d+\.embedding type=vector /);
    // Seeded provider/model catalog.
    expect(chain.rowCounts).toMatch(/rows models = \d+/);
    expect(chain.rowCounts).toMatch(/rows providers = \d+/);
  }, 120_000);
});
