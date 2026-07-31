/**
 * The BST-992 exhaustiveness guard: every table that EXISTS in a fully
 * migrated database must be either in the reset-table registry (cleared by
 * every table-enumerating reset path) or in `RESET_EXCLUDED_TABLES` with a
 * written reason. A migration that adds a table without a clear-or-exclude
 * decision goes red here — this is what closes the BST-862/BST-844 drift class
 * from the database side, complementing the registry↔call-site parity checks
 * in `reset-table-registry.test.tsx` and the test-owned fixtures in
 * `clear-data.integration.test.tsx`.
 *
 * The audit function itself is control-tested with fabricated inputs in the
 * unit file; this file runs the real sweep.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditResetTableCoverage,
  getMastraResetTables,
  getResetTables,
} from '../src/reset-table-registry';
import { createMigratedTestDb } from './helpers/migrated-test-db';

describe('reset-table coverage (real migrated database)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function sweepPublicBaseTables(): Promise<readonly string[]> {
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    return result.rows.map((row) => row.table_name);
  }

  it('every existing table is registered as cleared or excluded-with-reason', async () => {
    const existing = await sweepPublicBaseTables();
    // Sanity: an empty sweep would make the audit vacuously green.
    expect(existing.length).toBeGreaterThan(20);

    const audit = auditResetTableCoverage(existing);
    expect(
      audit.unregistered,
      'Unregistered table(s) found. Every table needs an explicit decision: add it to the reset set in reset-table-registry.ts (and a call site in each reset path) or to RESET_EXCLUDED_TABLES with the reason it survives.'
    ).toEqual([]);
    expect(audit.doubleRegistered).toEqual([]);
  });

  it('every migration-backed registry table actually exists (registry names cannot rot)', async () => {
    // The probe helpers tolerate absence by design, so a misspelled registry
    // name would otherwise become a permanent silent skip (the to_regclass
    // hazard). The Mastra six are the only legitimately-lazy members: they are
    // application-created and absent on a freshly migrated database.
    const lazy = new Set<string>(getMastraResetTables());
    const existing = new Set(await sweepPublicBaseTables());
    for (const table of getResetTables()) {
      if (lazy.has(table)) {
        expect(existing.has(table), `${table} should be lazy-absent`).toBe(false);
        continue;
      }
      expect(existing.has(table), `${table} missing from the migrated database`).toBe(true);
    }
  });
});
