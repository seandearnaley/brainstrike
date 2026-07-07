/**
 * Mastra observational-memory (OM) schema projection / drift guard.
 *
 * The OM context meter (packages/ui/src/assistant-ui-panel/context-usage-meter.tsx,
 * fed by packages/app-shell/src/assistant-om-segment.ts) reads RAW @mastra/memory
 * columns off the `mastra_observational_memory` table via a live query. Those
 * column identifiers, SQL types, and nullability are NOT owned by brainstrike —
 * they are mirrored from the pinned @mastra/memory library into
 * `MASTRA_MEMORY_SCHEMA_SQL`. A silent null-read (e.g. a future @mastra/memory
 * bump renames `observationTokenCount`, or the SQL mirror drifts) would make the
 * meter fabricate a 0 segment, which violates the no-silent-fallbacks rule.
 *
 * This test bootstraps the real `MASTRA_MEMORY_SCHEMA_SQL` into a real PGlite
 * (FULL extension set per the PGLITE EXTENSION INVARIANT) and asserts the EXACT
 * identifier / data_type / is_nullable of EVERY column the meter reads. It FAILS
 * LOUDLY if any of those columns is added, removed, renamed, or retyped — so the
 * meter can never silently null-read after a library bump.
 *
 * Because @mastra/memory is pinned to an exact version (packages/agent/package.json),
 * a bump is a deliberate, reviewable change that MUST update this projection.
 */

import {
  MASTRA_MEMORY_SCHEMA_SQL,
  MASTRA_MEMORY_TABLES,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BOOTSTRAP_TIMEOUT_MS = 30_000;

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: 'NO' | 'YES';
}

/**
 * The exact projection the OM meter depends on. Each entry is a column the meter
 * (or its compaction stat / latest-row ordering / lookup-key query) reads from
 * `mastra_observational_memory`. data_type / is_nullable are the values PGlite's
 * `information_schema.columns` reports for the columns declared in
 * MASTRA_MEMORY_SCHEMA_SQL, which mirror @mastra/memory@1.20.0's
 * OBSERVATIONAL_MEMORY_SCHEMA descriptor.
 *
 * If a @mastra/memory bump changes any of these, this object MUST be updated in
 * the same PR as the version bump — that is the whole point of the guard.
 */
const REQUIRED_OM_COLUMNS: Record<string, { dataType: string; isNullable: 'NO' | 'YES' }> = {
  createdAt: { dataType: 'timestamp with time zone', isNullable: 'NO' },
  generationCount: { dataType: 'integer', isNullable: 'NO' },
  // Row identity + latest-generation ordering (getObservationalMemory orders by
  // generationCount DESC, createdAt DESC).
  id: { dataType: 'text', isNullable: 'NO' },
  // Row keying — the meter looks up `thread:{threadId}` against lookupKey.
  lookupKey: { dataType: 'text', isNullable: 'NO' },
  // The "observation" segment value.
  observationTokenCount: { dataType: 'integer', isNullable: 'NO' },
  threadId: { dataType: 'text', isNullable: 'YES' },
  // The compaction-benefit stat numerator (totalTokensObserved − observationTokenCount).
  totalTokensObserved: { dataType: 'integer', isNullable: 'NO' },
};

describe('Mastra OM schema projection (drift guard)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_trgm: pgTrgm, vector } });
    await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
  });

  afterEach(async () => {
    await db.close();
  });

  async function readOmColumns(): Promise<Map<string, ColumnRow>> {
    const result = await db.query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = $1`,
      [MASTRA_MEMORY_TABLES.observationalMemory]
    );
    return new Map(result.rows.map((row) => [row.column_name, row]));
  }

  it(
    'creates the observational memory table',
    async () => {
      const columns = await readOmColumns();
      expect(columns.size).toBeGreaterThan(0);
    },
    BOOTSTRAP_TIMEOUT_MS
  );

  it(
    'projects every column the OM meter reads with the exact identifier, type, and nullability',
    async () => {
      const columns = await readOmColumns();

      for (const [name, expected] of Object.entries(REQUIRED_OM_COLUMNS)) {
        const actual = columns.get(name);
        // Loud, identifier-specific failure: a renamed/removed column is named.
        expect(
          actual,
          `OM meter column "${name}" is missing from mastra_observational_memory`
        ).toBeDefined();
        expect(actual?.data_type, `OM meter column "${name}" changed data_type`).toBe(
          expected.dataType
        );
        expect(actual?.is_nullable, `OM meter column "${name}" changed nullability`).toBe(
          expected.isNullable
        );
      }
    },
    BOOTSTRAP_TIMEOUT_MS
  );

  it(
    'keeps the meter-critical integer token columns NOT NULL (so a strict parser can trust them)',
    async () => {
      const columns = await readOmColumns();
      // The meter's honest-state contract relies on these being NOT NULL integers:
      // a NULL here would be a malformed row → error state, never a fabricated 0.
      for (const name of ['observationTokenCount', 'totalTokensObserved', 'generationCount']) {
        const actual = columns.get(name);
        expect(actual?.data_type, `${name} must be integer`).toBe('integer');
        expect(actual?.is_nullable, `${name} must be NOT NULL`).toBe('NO');
      }
    },
    BOOTSTRAP_TIMEOUT_MS
  );
});
