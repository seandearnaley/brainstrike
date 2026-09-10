import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { ToolOutputArtifactRepository } from '../src/repositories/tool-output-artifact-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

let db: PGlite;
let runner: MigrationRunner;
beforeEach(async () => {
  db = await wasmLoader.createPGlite(createPGliteTestDataDir('artifact-execution-migration'));
  runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations.filter((migration) => migration.version < 129));
});
afterEach(async () => {
  await db?.close();
});

it('preserves legacy artifact identity and bytes while admitting native siblings', async () => {
  await db.query(`INSERT INTO brainstrike_assistant_tool_output_artifacts
    (id, resource_id, thread_id, run_id, tool_call_id, format, content, byte_length, created_at, expires_at)
    VALUES ('legacy', 'owner', 'root', 'run', 'call', 'text', decode('610062', 'hex'), 3, NOW(), NOW() + interval '7 days')`);
  const migration = migrations.find((item) => item.version === 129);
  if (!migration) {
    throw new Error('Artifact execution scope migration is missing');
  }
  await runner.runMigration(migration);
  await runner.up(migrations);
  const repository = new ToolOutputArtifactRepository(db);
  const input = {
    content: 'a\u0000b',
    format: 'text' as const,
    resourceId: 'owner',
    runId: 'run',
    threadId: 'root',
    toolCallId: 'call',
  };
  const legacy = await repository.store(input);
  expect(legacy.id).toBe('legacy');
  const nativeRoot = await repository.store({ ...input, executionThreadId: 'root' });
  expect(nativeRoot).toEqual(legacy);
  const child = await repository.store({
    ...input,
    content: 'child',
    executionThreadId: 'native-child',
  });
  expect(child.id).not.toBe(legacy.id);
  const rows = await db.query<{ id: string; scope: string; content: Uint8Array }>(
    'SELECT id, execution_thread_id AS scope, content FROM brainstrike_assistant_tool_output_artifacts ORDER BY id'
  );
  expect(rows.rows.find((row) => row.id === 'legacy')?.scope).toBe('root');
  expect(Array.from(rows.rows.find((row) => row.id === 'legacy')?.content ?? [])).toEqual([
    97, 0, 98,
  ]);
  await expect(repository.store({ ...input, executionThreadId: '' })).rejects.toThrow(
    'executionThreadId'
  );
  if (typeof migration.down !== 'string') {
    throw new Error('Missing rollback SQL');
  }
  await expect(db.exec(migration.down)).rejects.toThrow(
    'Cannot discard delegated artifact execution identity'
  );
  expect(
    (await db.query('SELECT id FROM brainstrike_assistant_tool_output_artifacts')).rows
  ).toHaveLength(2);
});
