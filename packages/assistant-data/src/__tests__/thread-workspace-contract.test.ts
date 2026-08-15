import { THREAD_DELETE_SIDECAR_TABLES } from '@brainstrike/assistant-contract';
import { getResetTables, migrations } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import { buildAssistantThreadRunsSchemaSql } from '../assistant-memory-repository';

/**
 * Living-contract pins for `brainstrike_assistant_thread_workspaces`
 * (BST-1268, migration 094; see docs/agents/database.md). A persistent
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
  it('migration 094 and the renderer bootstrap declare the SAME table shape', () => {
    const migration = migrations.find((candidate) => candidate.version === 94);
    expect(migration, 'migration 094 registered in the numbered runner').toBeDefined();
    const migrationBlock = extractCreateTableBlock(String(migration?.up ?? ''), TABLE);
    const bootstrapBlock = extractCreateTableBlock(buildAssistantThreadRunsSchemaSql(), TABLE);
    expect(bootstrapBlock).toBe(migrationBlock);
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
