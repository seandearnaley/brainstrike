/**
 * The in-flight read runs against the migrated tables it names. A run still
 * streaming or cancelling, and a background task still pending or running,
 * hold off unpreemptable maintenance; terminal rows and a task suspended on the
 * user do not (database.md, unpreemptable maintenance and assistant work).
 */
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readInFlightAssistantWork } from '../maintenance-admission';

let database: PGlite;

beforeEach(async () => {
  database = await wasmLoader.createPGlite('memory://maintenance-admission');
  await migrate(database);
  await database.exec(`INSERT INTO mastra_threads
    (id, "resourceId", title, metadata, "createdAt", "updatedAt")
    VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW())`);
});

afterEach(async () => {
  await database.close();
});

async function insertRun(status: string): Promise<void> {
  await database.query(
    `INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id)
     VALUES ($1, 'owner', 'root', 'openai', 'test', 'desktop', $2, NOW(), NOW(), NOW(), 'turn')`,
    [`run-${status}`, status]
  );
}

async function insertTask(status: string): Promise<void> {
  await database.query(
    `INSERT INTO mastra_background_tasks
      (id, tool_call_id, tool_name, agent_id, run_id, thread_id, resource_id, status,
       args, retry_count, max_retries, timeout_ms, "createdAt")
     VALUES ($1, $1, 'agent-explore', 'root-agent', 'native-run', 'root', 'owner', $2,
       '{}', 0, 0, 60000, NOW())`,
    [`task-${status}`, status]
  );
}

describe('readInFlightAssistantWork', () => {
  it('reads an empty database as no in-flight work', async () => {
    await expect(readInFlightAssistantWork(database)).resolves.toEqual({
      backgroundTasks: 0,
      runs: 0,
    });
  });

  it('counts only runs and background tasks that can still issue database work', async () => {
    for (const status of ['running', 'cancelling', 'completed', 'failed', 'cancelled']) {
      await insertRun(status);
    }
    for (const status of [
      'pending',
      'running',
      'suspended',
      'completed',
      'failed',
      'cancelled',
      'timed_out',
    ]) {
      await insertTask(status);
    }

    await expect(readInFlightAssistantWork(database)).resolves.toEqual({
      backgroundTasks: 2,
      runs: 2,
    });
  });
});
