import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the assistant run-errors table.
 *
 * Was migration-076's suite. Dropped: "creates the FK-less table, lifecycle
 * indexes, and diagnostic run index" -- including its column-order and
 * absent-`attempts` assertions, all of which the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt pins by ordinal position for
 * every column of every table -- and "round-trips down/up idempotently",
 * because ADR-0020 does not build rollback.
 *
 * Kept: that each honest-shape CHECK actually REJECTS. A dump can print a
 * CHECK's expression; only an INSERT proves it fires.
 */
describe('assistant run errors', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  function insert(overrides: {
    causeChain?: string;
    code?: string;
    httpStatus?: number;
    responseHeaders?: string;
    runId?: string;
  }): Promise<unknown> {
    return db.query(
      `INSERT INTO brainstrike_assistant_run_errors (
         run_id, thread_id, resource_id, code, cause_chain, http_status,
         response_headers, occurred_at
       ) VALUES ($1, 'thread-a', 'resource-a', $2, $3::jsonb, $4, $5::jsonb, NOW())`,
      [
        overrides.runId ?? 'run-a',
        overrides.code ?? 'provider_error',
        overrides.causeChain ?? '[]',
        overrides.httpStatus ?? 500,
        overrides.responseHeaders ?? '{}',
      ]
    );
  }

  it('accepts a well-formed error row', async () => {
    await insert({});

    const rows = await db.query('SELECT * FROM brainstrike_assistant_run_errors');
    expect(rows.rows).toHaveLength(1);
  });

  it('enforces honest JSON shapes, HTTP status, and required identifiers', async () => {
    // cause_chain must be an array, response_headers an object.
    await expect(insert({ causeChain: '{}' })).rejects.toThrow();
    await expect(insert({ responseHeaders: '[]' })).rejects.toThrow();
    await expect(insert({ httpStatus: 99 })).rejects.toThrow();
    await expect(insert({ code: '' })).rejects.toThrow();
    await expect(insert({ runId: '' })).rejects.toThrow();
  });
});
