import { THREAD_DELETE_SIDECAR_TABLES } from '@brainstrike/assistant-contract';
import { getResetTables, migrations } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import { requiredAssistantMemoryRelations } from '../assistant-memory-repository';

/**
 * Living-contract pins for `brainstrike_assistant_thread_workspaces`
 * (BST-1268, migration 095; see docs/agents/database.md). A persistent
 * sidecar carries FOUR obligations beyond its own migration — this suite
 * fails if any of them drifts.
 */

const TABLE = 'brainstrike_assistant_thread_workspaces';

function extractCreateTableBlock(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
  expect(start, `${table} CREATE TABLE block present`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(');', start);
  expect(end).toBeGreaterThan(start);
  // Normalize whitespace so formatting differences cannot mask (or fake)
  // a column/type/constraint divergence.
  return sql
    .slice(start, end + 2)
    .replace(/\s+/g, ' ')
    .trim();
}

describe('thread workspace persistence contract', () => {
  it('migration 095 is the sole declaration of the table shape', () => {
    const migration = migrations.find((candidate) => candidate.version === 95);
    expect(migration, 'migration 095 registered in the migration manifest').toBeDefined();
    expect(extractCreateTableBlock(String(migration?.up ?? ''), TABLE)).toBe(
      `CREATE TABLE IF NOT EXISTS ${TABLE} ( thread_id text PRIMARY KEY, resource_id text NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT NOW() );`
    );
  });

  it('the repository PROBES for the table rather than creating it (BST-1651)', () => {
    // Pre-BST-1651 this obligation read "mirror the migration byte-identically
    // in the renderer bootstrap". The bootstrap is gone: a sidecar the
    // thread-delete cascade references unconditionally must instead be part of
    // the schema probe, so an un-migrated database fails by name up front.
    expect(requiredAssistantMemoryRelations()).toContain(TABLE);
  });

  it('thread deletion cascades the workspace row via the shared sidecar list', () => {
    expect(THREAD_DELETE_SIDECAR_TABLES).toContainEqual({
      table: TABLE,
      threadColumn: 'thread_id',
    });
  });

  it('factory reset clears the table via the reset registry', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});
