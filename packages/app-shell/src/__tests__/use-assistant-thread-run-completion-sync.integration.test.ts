/**
 * The run-completion signature against REAL PGlite and the real `thread_runs`
 * table (BST-1844).
 *
 * The sibling unit suite mocks the live query, so it proves what the hook does
 * with a signature and nothing about the SQL that produces one: a misspelt column
 * or a status list that misses a terminal state is a well-formed string that
 * would leave the badge stale forever. Only executing the SELECT over rows the
 * production writers produced falsifies that. The database is migrated first and
 * rows are written through the production repository (`createThreadRun`,
 * `completeThreadRun`).
 */
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import {
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSISTANT_THREAD_RUN_COMPLETIONS_SQL } from '../use-assistant-thread-run-completion-sync';

const RESOURCE_ID = 'workspace-a';
const OTHER_RESOURCE_ID = 'workspace-b';

let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
let repository: AssistantThreadRepository;

async function startRun(resourceId: string, runId: string): Promise<void> {
  const thread = await repository.createThread(resourceId);
  await repository.createThreadRun({
    id: runId as HostRunId,
    model: 'test-model',
    provider: 'test-provider',
    resourceId,
    runtimeKind: 'hosted',
    threadId: thread.id,
  });
}

/** The signature the live query would deliver: always exactly one row. */
async function signature(resourceId: string): Promise<string> {
  const result = await database.query<Record<string, unknown>>(
    ASSISTANT_THREAD_RUN_COMPLETIONS_SQL,
    [resourceId]
  );
  expect(result.rows).toHaveLength(1);
  return JSON.stringify(result.rows);
}

beforeEach(async () => {
  database = await wasmLoader.createPGlite('memory://');
  await migrate(database);
  repository = createPgliteAssistantThreadRepository(database as DbHandle);
});

afterEach(async () => {
  await database.close();
});

describe('run-completion signature on real PGlite', () => {
  it('delivers one zero row for a resource with no runs, as plain JSON', async () => {
    expect(await signature(RESOURCE_ID)).toBe('[{"terminalCount":0,"lastCompletedAt":null}]');
  });

  it('does not move when a run starts', async () => {
    const before = await signature(RESOURCE_ID);

    await startRun(RESOURCE_ID, 'run-1');

    expect(await signature(RESOURCE_ID)).toBe(before);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'moves when a run reaches %s',
    async (status) => {
      await startRun(RESOURCE_ID, 'run-1');
      const running = await signature(RESOURCE_ID);

      await repository.completeThreadRun('run-1', { status });

      const terminal = await signature(RESOURCE_ID);
      expect(terminal).not.toBe(running);
      expect(JSON.parse(terminal)).toEqual([
        { lastCompletedAt: expect.any(String), terminalCount: 1 },
      ]);
    }
  );

  it('moves when a second run completes', async () => {
    await startRun(RESOURCE_ID, 'run-1');
    await repository.completeThreadRun('run-1', { status: 'completed' });
    const afterFirst = await signature(RESOURCE_ID);
    await startRun(RESOURCE_ID, 'run-2');

    await repository.completeThreadRun('run-2', { status: 'completed' });

    expect(await signature(RESOURCE_ID)).not.toBe(afterFirst);
  });

  // A run that pauses and resumes leaves a terminal status and re-enters one, so
  // the count returns to its old value and only the completion time has moved.
  it('moves when a resumed run reaches its terminal state again at the same count', async () => {
    await startRun(RESOURCE_ID, 'run-1');
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs
       SET status = 'completed', completed_at = '2026-09-28T10:00:00Z' WHERE id = 'run-1'`
    );
    const first = await signature(RESOURCE_ID);
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET status = 'running', completed_at = NULL WHERE id = 'run-1'`
    );

    await database.query(
      `UPDATE brainstrike_assistant_thread_runs
       SET status = 'completed', completed_at = '2026-09-28T10:07:00Z' WHERE id = 'run-1'`
    );

    const resumed = await signature(RESOURCE_ID);
    expect(resumed).not.toBe(first);
    expect(JSON.parse(resumed)[0].terminalCount).toBe(JSON.parse(first)[0].terminalCount);
  });

  it('does not move for a write that changes no run status or completion', async () => {
    await startRun(RESOURCE_ID, 'run-1');
    const before = await signature(RESOURCE_ID);

    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET updated_at = NOW(), error = 'noted' WHERE id = 'run-1'`
    );

    expect(await signature(RESOURCE_ID)).toBe(before);
  });

  it("does not move for another resource's runs", async () => {
    const before = await signature(RESOURCE_ID);

    await startRun(OTHER_RESOURCE_ID, 'run-other');
    await repository.completeThreadRun('run-other', { status: 'completed' });

    expect(await signature(RESOURCE_ID)).toBe(before);
  });
});
