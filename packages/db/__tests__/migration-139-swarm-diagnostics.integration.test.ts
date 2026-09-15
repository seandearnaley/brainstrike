import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration139SwarmDiagnostics } from '../src/migrations/139-swarm-diagnostics.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

const TABLES = [
  'brainstrike_assistant_prompt_manifests',
  'brainstrike_delegated_wakeups',
  'brainstrike_delegated_live_decisions',
] as const;

async function columns(db: PGlite, table: string): Promise<string[]> {
  const result = await db.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
    [table]
  );
  return result.rows.map((row) => row.column_name);
}

describe('migration 139 swarm diagnostics', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('migration-139'));
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
  });
  afterEach(async () => {
    await db.close();
  });

  it('creates the three tables with their evidence columns', async () => {
    expect(await columns(db, 'brainstrike_assistant_prompt_manifests')).toEqual([
      'id',
      'host_run_id',
      'thread_id',
      'kind',
      'native_run_id',
      'parent_tool_call_id',
      'persona_id',
      'provider',
      'model',
      'system_context_source',
      'system_messages',
      'persona_instructions',
      'delegation_prompt',
      'tool_names',
      'total_chars',
      'truncated',
      'created_at',
    ]);
    expect(await columns(db, 'brainstrike_delegated_wakeups')).toEqual([
      'id',
      'host_run_id',
      'root_thread_id',
      'kind',
      'directive',
      'invocations',
      'created_at',
    ]);
    expect(await columns(db, 'brainstrike_delegated_live_decisions')).toEqual([
      'id',
      'host_run_id',
      'root_thread_id',
      'task_id',
      'tool_call_id',
      'delegation_tool_call_id',
      'tool_name',
      'kind',
      'decision',
      'source',
      'outcome',
      'reason',
      'answered_sibling_task_ids',
      'policy_snapshot',
      'occurred_at',
    ]);
    expect(migration139SwarmDiagnostics.ledgerKey).toBe('custom-139-swarm-diagnostics');
  });

  it('cascades every row when the host run is deleted and rejects unknown kinds', async () => {
    await db.exec(`INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', now(), now());
      INSERT INTO brainstrike_assistant_thread_runs
        (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
      VALUES ('leg', 'owner', 'root', 'openai', 'm', 'agent', 'running', now(), now(), now());
      INSERT INTO brainstrike_assistant_prompt_manifests
        (id, host_run_id, thread_id, kind, system_context_source, system_messages, tool_names, total_chars)
      VALUES ('pm', 'leg', 'root', 'root-leg', 'captured', '[]', '[]', 0);
      INSERT INTO brainstrike_delegated_wakeups (id, host_run_id, root_thread_id, kind, directive, invocations)
      VALUES ('wk', 'leg', 'root', 'idle-loop', 'text', '[]');
      INSERT INTO brainstrike_delegated_live_decisions
        (id, host_run_id, root_thread_id, tool_call_id, kind, source, outcome)
      VALUES ('ld', 'leg', 'root', 'call', 'approval', 'user', 'delivered');`);
    await expect(
      db.exec(`INSERT INTO brainstrike_delegated_wakeups (id, host_run_id, root_thread_id, kind, directive, invocations)
        VALUES ('bad', 'leg', 'root', 'human', 'text', '[]');`)
    ).rejects.toThrow(/check constraint/i);
    await db.exec("DELETE FROM brainstrike_assistant_thread_runs WHERE id = 'leg'");
    for (const table of TABLES) {
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    }
  });

  it('replays over an already-migrated database and rolls back cleanly', async () => {
    if (typeof migration139SwarmDiagnostics.up !== 'string') {
      throw new Error('migration 139 must carry SQL-string up');
    }
    if (typeof migration139SwarmDiagnostics.down !== 'string') {
      throw new Error('migration 139 must carry SQL-string down');
    }
    await db.exec(migration139SwarmDiagnostics.up);
    await db.exec(migration139SwarmDiagnostics.down);
    for (const table of TABLES) {
      expect((await db.query('SELECT to_regclass($1) AS r', [table])).rows).toEqual([{ r: null }]);
    }
  });
});
