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
  getFactoryResetOnlyTables,
  getLazyMastraResetTables,
  getResetTables,
  RESET_EXCLUDED_TABLES,
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
    // hazard). Since BST-1651 only `mastra_vectors` and
    // `mastra_workflow_snapshot` are legitimately lazy — Mastra's vector store
    // and workflow storage create those; migration 117 creates the four memory
    // relations, which the assistant repository probes for at startup.
    const lazy = new Set<string>(getLazyMastraResetTables());
    const existing = new Set(await sweepPublicBaseTables());
    for (const table of getResetTables()) {
      if (lazy.has(table)) {
        expect(existing.has(table), `${table} should be lazy-absent`).toBe(false);
        continue;
      }
      expect(existing.has(table), `${table} missing from the migrated database`).toBe(true);
    }
    // The factory-reset-only six are all migration-backed — a stale name here
    // would be the same silent-skip rot the reset-set check closes.
    for (const table of getFactoryResetOnlyTables()) {
      expect(existing.has(table), `${table} missing from the migrated database`).toBe(true);
    }
  });

  // The exclusion ledger's symmetric rot hazard (review #2155): several
  // entries survive reset ONLY because of a claimed `ON DELETE CASCADE`, and
  // prose cannot notice a migration dropping or re-creating that FK without
  // cascade — the table would stay excluded-with-reason, the sweep would stay
  // green, and the rows would survive reset (BST-862's shape, one indirection
  // over). So the claim is verified against the live catalog: every
  // cascade-justified exclusion that exists in a migrated database must have
  // at least one CASCADE foreign key. Bootstrap-only DDL
  // (`brainstrike_assistant_thread_runs`/`run_events`) is absent here and
  // stays covered by the contract doc's move-into-registry instruction.
  it('every cascade-justified exclusion still has its cascading FK', async () => {
    const result = await db.query<{ child: string }>(
      `SELECT DISTINCT tc.table_name AS child
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name
          AND rc.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND rc.delete_rule = 'CASCADE'`
    );
    const cascading = new Set(result.rows.map((row) => row.child));
    // Control: the query shape must actually see CASCADE FKs, or every
    // assertion below is vacuously green.
    expect(cascading.size).toBeGreaterThan(0);

    const existing = new Set(await sweepPublicBaseTables());
    const cascadeJustified = Object.entries(RESET_EXCLUDED_TABLES)
      .filter(([, reason]) => reason.includes('ON DELETE CASCADE'))
      .map(([table]) => table);
    expect(cascadeJustified.length).toBeGreaterThan(0);
    for (const table of cascadeJustified) {
      if (!existing.has(table)) {
        continue;
      }
      expect(
        cascading.has(table),
        `${table} is excluded as cascade-covered but has no ON DELETE CASCADE foreign key — ` +
          'either restore the FK or move the table into the reset set.'
      ).toBe(true);
    }
  });
});
