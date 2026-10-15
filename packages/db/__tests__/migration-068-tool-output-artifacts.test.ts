import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface CountRow {
  count: number | string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('migration 068: tool output artifacts', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(67);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration068() {
    const migration = migrations.find((candidate) => candidate.version === 68);
    if (!migration) {
      throw new Error('Migration 068 is missing');
    }
    return migration;
  }

  it('creates an immutable byte-accurate artifact table and lifecycle indexes', async () => {
    await runner.runMigration(getMigration068());

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_tool_output_artifacts'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'brainstrike_assistant_tool_output_artifacts'`
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('bst_tool_output_artifacts_scope_call_uidx');
    expect(names).toContain('bst_tool_output_artifacts_expires_idx');
  });

  it('stores exact bytes and rejects inconsistent metadata', async () => {
    await runner.runMigration(getMigration068());

    const content = new TextEncoder().encode('A\u0000🙂\nB');
    await db.query(
      `INSERT INTO brainstrike_assistant_tool_output_artifacts (
         resource_id, thread_id, run_id, tool_call_id, format,
         content, byte_length, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), $7, $8, $9)`,
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
      ]
    );

    const stored = await db.query<{ byteLength: number; content: Uint8Array }>(
      `SELECT content, byte_length AS "byteLength"
       FROM brainstrike_assistant_tool_output_artifacts`
    );
    expect(Array.from(stored.rows[0]?.content ?? [])).toEqual(Array.from(content));
    expect(Number(stored.rows[0]?.byteLength)).toBe(content.byteLength);

    await expect(
      db.query(
        `UPDATE brainstrike_assistant_tool_output_artifacts
         SET byte_length = byte_length + 1`
      )
    ).rejects.toThrow();
    await expect(
      db.query(
        `UPDATE brainstrike_assistant_tool_output_artifacts
         SET format = 'binary'`
      )
    ).rejects.toThrow();
  });

  it('rejects duplicate tool-call ownership and non-forward expiry', async () => {
    await runner.runMigration(getMigration068());

    const insert = async (toolCallId: string, expiresAt: string) =>
      await db.query(
        `INSERT INTO brainstrike_assistant_tool_output_artifacts (
           resource_id, thread_id, run_id, tool_call_id, format,
           content, byte_length, created_at, expires_at
         ) VALUES (
           'workspace-a', 'thread-a', 'run-a', $1, 'json',
           decode($2, 'hex'), 2, '2026-07-19T12:00:00.000Z', $3
         )`,
        [toolCallId, bytesToHex(new TextEncoder().encode('{}')), expiresAt]
      );

    await insert('call-a', '2026-07-26T12:00:00.000Z');
    await expect(insert('call-a', '2026-07-27T12:00:00.000Z')).rejects.toThrow();
    await expect(insert('call-b', '2026-07-19T12:00:00.000Z')).rejects.toThrow();
  });

  it('rollback drops the artifact table', async () => {
    const migration = getMigration068();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_tool_output_artifacts'`
    );
    expect(Number(table.rows[0]?.count ?? -1)).toBe(0);
  });
});
