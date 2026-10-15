import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the diagnostic-events table.
 *
 * Was migration-073's suite. Dropped: "creates the table with lifecycle
 * indexes", pinned exhaustively by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt, and "round-trips down/up
 * idempotently", because ADR-0020 does not build rollback. Kept: the closed
 * severity vocabulary, which the dump states but cannot prove rejects anything.
 */
describe('diagnostic events', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('rejects a severity outside warn|error|fatal', async () => {
    await expect(
      db.query(
        `INSERT INTO brainstrike_diagnostic_events
           (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
         VALUES ('e1', NOW(), 'info', 'web-renderer', 'm', 'f', 's', 'v', 'p')`
      )
    ).rejects.toThrow();
  });
});
