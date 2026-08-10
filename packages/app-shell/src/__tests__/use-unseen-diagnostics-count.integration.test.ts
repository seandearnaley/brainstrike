import { wasmLoader } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNSEEN_DIAGNOSTICS_QUERY } from '../diagnostics/use-unseen-diagnostics-count';

describe('unseen diagnostics aggregate query', () => {
  let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://');
    await database.exec(`
      CREATE TABLE brainstrike_diagnostic_events (
        id text PRIMARY KEY,
        occurred_at timestamptz NOT NULL,
        severity text NOT NULL CHECK (severity IN ('warn', 'error', 'fatal'))
      );
      INSERT INTO brainstrike_diagnostic_events (id, occurred_at, severity) VALUES
        ('old-warning', '2026-08-10T11:59:59.000Z', 'warn'),
        ('warning', '2026-08-10T12:00:01.000Z', 'warn'),
        ('error', '2026-08-10T12:00:02.000Z', 'error'),
        ('fatal', '2026-08-10T12:00:03.000Z', 'fatal');
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  it('executes on real PGlite and preserves the quoted aggregate aliases', async () => {
    const result = await database.query<{ errorCount: number; warningCount: number }>(
      UNSEEN_DIAGNOSTICS_QUERY,
      ['2026-08-10T12:00:00.000Z']
    );

    expect(result.rows).toEqual([{ errorCount: 2, warningCount: 1 }]);
  });
});
