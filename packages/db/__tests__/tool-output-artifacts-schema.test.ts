import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_assistant_tool_output_artifacts';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Runtime behaviour of the immutable tool-output artifact table.
 *
 * Was migration-068's suite. Dropped: "creates the table and lifecycle indexes",
 * pinned exhaustively by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt, and "rollback drops the
 * table", because ADR-0020 does not build rollback.
 *
 * Kept: byte-exact round-tripping (including a NUL and astral-plane codepoint),
 * the immutability guards, the unique tool-call ownership and the
 * forward-expiry CHECK -- all behaviour an INSERT or UPDATE has to prove.
 *
 * The fixtures carry `execution_thread_id`, which migration-068 did not create
 * and a later migration added NOT NULL. Rewriting against the shipped schema
 * rather than against one chain step is what surfaced that; the old fixtures
 * only ever had to satisfy the table as it looked at version 68.
 */
describe('tool output artifacts', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores exact bytes and rejects inconsistent metadata', async () => {
    const content = new TextEncoder().encode('A\u0000🙂\nB');
    await db.query(
      `INSERT INTO ${TABLE} (
         resource_id, thread_id, run_id, tool_call_id, format,
         content, byte_length, created_at, expires_at, execution_thread_id
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), $7, $8, $9, $10)`,
      [
        'workspace-a',
        'thread-a',
        'run-a',
        'call-a',
        'text',
        bytesToHex(content),
        content.byteLength,
        '2026-07-19T12:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
        'thread-a',
      ]
    );

    const stored = await db.query<{ byteLength: number; content: Uint8Array }>(
      `SELECT content, byte_length AS "byteLength" FROM ${TABLE}`
    );
    expect(Array.from(stored.rows[0]?.content ?? [])).toEqual(Array.from(content));
    expect(Number(stored.rows[0]?.byteLength)).toBe(content.byteLength);

    await expect(db.query(`UPDATE ${TABLE} SET byte_length = byte_length + 1`)).rejects.toThrow();
    await expect(db.query(`UPDATE ${TABLE} SET format = 'binary'`)).rejects.toThrow();
  });

  it('rejects duplicate tool-call ownership and non-forward expiry', async () => {
    const insert = async (toolCallId: string, expiresAt: string) =>
      await db.query(
        `INSERT INTO ${TABLE} (
           resource_id, thread_id, run_id, tool_call_id, format,
           content, byte_length, created_at, expires_at, execution_thread_id
         ) VALUES (
           'workspace-a', 'thread-a', 'run-a', $1, 'json',
           decode($2, 'hex'), 2, '2026-07-19T12:00:00.000Z', $3, 'thread-a'
         )`,
        [toolCallId, bytesToHex(new TextEncoder().encode('{}')), expiresAt]
      );

    await insert('call-a', '2026-07-26T12:00:00.000Z');
    await expect(insert('call-a', '2026-07-27T12:00:00.000Z')).rejects.toThrow();
    await expect(insert('call-b', '2026-07-19T12:00:00.000Z')).rejects.toThrow();
  });
});
