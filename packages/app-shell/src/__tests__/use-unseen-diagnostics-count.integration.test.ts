import { MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNSEEN_DIAGNOSTICS_QUERY } from '../diagnostics/use-unseen-diagnostics-count';

describe('unseen diagnostics aggregate query', () => {
  let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://');
    // Was "apply only migration 073" to get `brainstrike_diagnostic_events`.
    // The chain collapsed into one current-schema DDL (ADR-0020), so the
    // registry is applied whole; the query under test is unchanged.
    const runner = new MigrationRunner(database);
    await runner.initialize();
    await runner.up(migrations);
    await database.query(
      `INSERT INTO brainstrike_diagnostic_events
         (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
       VALUES
         ('old-warning', '2026-08-10T11:59:59.000Z', 'warn', 'web-renderer', 'm', 'f1', 's', 'v', 'p'),
         ('warning', '2026-08-10T12:00:01.000Z', 'warn', 'web-renderer', 'm', 'f2', 's', 'v', 'p'),
         ('error', '2026-08-10T12:00:02.000Z', 'error', 'web-renderer', 'm', 'f3', 's', 'v', 'p'),
         ('fatal', '2026-08-10T12:00:03.000Z', 'fatal', 'web-renderer', 'm', 'f4', 's', 'v', 'p')`
    );
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
