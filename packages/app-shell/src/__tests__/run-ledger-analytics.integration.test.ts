import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { getLedgerCostTrend, getModelComparison } from '../run-ledger-analytics';

let pgliteDataDirCounter = 0;

function createPgliteTestDataDir(prefix: string): string {
  pgliteDataDirCounter += 1;
  return `memory://${prefix}-${pgliteDataDirCounter}`;
}

describe('run ledger analytics (real PGlite)', () => {
  let pgliteDataDir: string | undefined;

  async function seedWorkspace(dataDirName: string) {
    pgliteDataDir = createPgliteTestDataDir(dataDirName);
    const db = await wasmLoader.createPGlite(pgliteDataDir);
    // Migrations 117/118 own the assistant schema; the repository probes for it
    // rather than creating it (BST-1651).
    await migrate(db);
    onTestFinished(async () => {
      await db.close();
      expect(db.closed).toBe(true);
    });
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    // Two sonnet runs on day 1 (one labeled succeeded, one failed via revert),
    // one gpt run on day 2 (unlabeled), one foreign-workspace run (excluded).
    await repository.createThreadRun({
      id: 'run-s1' as HostRunId,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-14T09:00:00Z'),
      status: 'running',
      threadId: thread.id,
    });
    await repository.completeThreadRun('run-s1', { status: 'completed' });
    await db.query('UPDATE brainstrike_assistant_thread_runs SET completed_at = $2 WHERE id = $1', [
      'run-s1',
      new Date('2026-07-14T09:01:00Z'),
    ]);
    await repository.createThreadRun({
      id: 'run-s2' as HostRunId,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-14T15:00:00Z'),
      status: 'running',
      threadId: thread.id,
    });
    await repository.completeThreadRun('run-s2', { status: 'completed' });
    await db.query('UPDATE brainstrike_assistant_thread_runs SET completed_at = $2 WHERE id = $1', [
      'run-s2',
      new Date('2026-07-14T15:03:00Z'),
    ]);
    await repository.createThreadRun({
      id: 'run-g1' as HostRunId,
      model: 'gpt-5.2',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-15T10:00:00Z'),
      status: 'running',
      threadId: thread.id,
    });
    await repository.completeThreadRun('run-g1', { error: 'boom', status: 'failed' });
    await repository.createThreadRun({
      id: 'run-foreign' as HostRunId,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-b',
      runtimeKind: 'hosted',
      startedAt: new Date('2026-07-14T09:00:00Z'),
      status: 'running',
      threadId: thread.id,
    });

    // Usage: created_at is the trend's time axis, so pin it per row.
    await repository.recordRunUsage({
      billedCostUsd: 0.4,
      inputTokens: 1000,
      model: 'claude-sonnet-5',
      outputTokens: 200,
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runId: 'run-s1',
      threadId: thread.id,
    });
    await repository.recordRunUsage({
      inputTokens: 500,
      model: 'claude-sonnet-5',
      outputTokens: 100,
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runId: 'run-s2',
      threadId: thread.id,
    });
    await repository.recordRunUsage({
      billedCostUsd: 1.25,
      inputTokens: 3000,
      model: 'gpt-5.2',
      outputTokens: 600,
      provider: 'openai',
      resourceId: 'workspace-a',
      runId: 'run-g1',
      threadId: thread.id,
    });
    await db.query(
      `UPDATE brainstrike_assistant_run_usage SET created_at = CASE run_id
         WHEN 'run-s1' THEN TIMESTAMPTZ '2026-07-14T09:01:00Z'
         WHEN 'run-s2' THEN TIMESTAMPTZ '2026-07-14T15:03:00Z'
         WHEN 'run-g1' THEN TIMESTAMPTZ '2026-07-15T10:02:00Z'
         ELSE created_at END`
    );

    await repository.recordRunOutcome({
      labeledAt: new Date('2026-07-14T09:05:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-s1',
      source: 'user',
      threadId: thread.id,
      verdict: 'succeeded',
    });
    await repository.recordRunOutcome({
      labeledAt: new Date('2026-07-14T15:10:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-s2',
      source: 'edit_revert',
      threadId: thread.id,
      verdict: 'failed',
    });

    return { db: db as DbHandle, repository, threadId: thread.id };
  }

  it('buckets cost and tokens over time with date_bin', async () => {
    const { db } = await seedWorkspace('ledger-analytics-trend');

    const trend = await getLedgerCostTrend(db, 'workspace-a', { bucket: 'day' });

    expect(trend).toHaveLength(2);
    const [day1, day2] = trend;
    expect(day1?.bucketStart.toISOString()).toBe('2026-07-14T00:00:00.000Z');
    expect(day1).toMatchObject({
      billedCostUsd: 0.4,
      estimatedInputTokens: 500,
      estimatedOutputTokens: 100,
      inputTokens: 1500,
      outputTokens: 300,
      runCount: 2,
    });
    expect(day2?.bucketStart.toISOString()).toBe('2026-07-15T00:00:00.000Z');
    expect(day2).toMatchObject({
      billedCostUsd: 1.25,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      inputTokens: 3000,
      outputTokens: 600,
      runCount: 1,
    });
  });

  it('supports hour buckets and rejects unknown buckets', async () => {
    const { db } = await seedWorkspace('ledger-analytics-hour');

    const trend = await getLedgerCostTrend(db, 'workspace-a', { bucket: 'hour' });
    expect(trend).toHaveLength(3);
    expect(trend[0]?.bucketStart.toISOString()).toBe('2026-07-14T09:00:00.000Z');

    await expect(
      getLedgerCostTrend(db, 'workspace-a', { bucket: 'fortnight' as never })
    ).rejects.toThrow(/unsupported trend bucket/i);
  });

  it('compares models across cost, duration, outcomes, and transport status', async () => {
    const { db } = await seedWorkspace('ledger-analytics-models');

    const comparison = await getModelComparison(db, 'workspace-a');

    expect(comparison).toHaveLength(2);
    const sonnet = comparison.find((row) => row.model === 'claude-sonnet-5');
    expect(sonnet).toMatchObject({
      billedCostUsd: 0.4,
      completedRunCount: 2,
      estimatedInputTokens: 500,
      estimatedOutputTokens: 100,
      failedRunCount: 0,
      inputTokens: 1500,
      labeledFailedCount: 1,
      labeledMixedCount: 0,
      labeledSucceededCount: 1,
      outputTokens: 300,
      provider: 'anthropic',
      runCount: 2,
    });
    // 60s + 180s of completed-run wall clock → 120s average.
    expect(sonnet?.avgDurationMs).toBe(120_000);

    const gpt = comparison.find((row) => row.model === 'gpt-5.2');
    expect(gpt).toMatchObject({
      billedCostUsd: 1.25,
      completedRunCount: 0,
      failedRunCount: 1,
      labeledFailedCount: 0,
      labeledSucceededCount: 0,
      runCount: 1,
    });
    expect(gpt?.avgDurationMs).toBeNull();
  });

  it('returns empty results for a workspace with no runs', async () => {
    const { db } = await seedWorkspace('ledger-analytics-empty');
    await expect(getLedgerCostTrend(db, 'workspace-none', { bucket: 'day' })).resolves.toEqual([]);
    await expect(getModelComparison(db, 'workspace-none')).resolves.toEqual([]);
  });
});
