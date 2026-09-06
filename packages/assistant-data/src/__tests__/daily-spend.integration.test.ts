import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { createPgliteAssistantThreadRepository } from '../assistant-memory-repository';
import { DAILY_SPEND_AGGREGATION_SQL, mapDailySpendUsageRow } from '../cost-tracking/daily-spend';
import { createMigratedTestPGlite } from './helpers/test-pglite';

let pgliteDataDirCounter = 0;

function createPgliteTestDataDir(prefix: string): string {
  pgliteDataDirCounter += 1;
  return `memory://${prefix}-${pgliteDataDirCounter}`;
}

interface LiveQuerySurface {
  live?: {
    query: (options: { params: readonly unknown[]; query: string }) => Promise<{
      initialResults: { rows: Record<string, unknown>[] };
      unsubscribe: () => Promise<void>;
    }>;
  };
}

describe('daily spend aggregation (real PGlite)', () => {
  let pgliteDataDir: string | undefined;

  it('is consumable through live.query and windows to the rolling last 24 hours', async () => {
    // The budget guardrail consumes DAILY_SPEND_AGGREGATION_SQL through
    // PGlite's live extension, whose format() rewrite breaks on repeated bind
    // parameters — same regression class pinned for RUN_LEDGER_AGGREGATION_SQL.
    pgliteDataDir = createPgliteTestDataDir('assistant-daily-spend-live');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    // In-window: one exact-cost row and one unreported row on the same model.
    await repository.recordRunUsage({
      billedCostUsd: 1.25,
      inputTokens: 100,
      model: 'gpt-5.2',
      outputTokens: 20,
      provider: 'openai',
      resourceId: 'workspace-a',
      rootId: null,
      runId: 'run-exact',
      threadId: thread.id,
    });
    await repository.recordRunUsage({
      inputTokens: 1000,
      model: 'gpt-5.2',
      outputTokens: 200,
      provider: 'openai',
      resourceId: 'workspace-a',
      rootId: null,
      runId: 'run-unreported',
      threadId: thread.id,
    });
    // Out-of-window: same shape, but created 25h ago — must be EXCLUDED.
    await repository.recordRunUsage({
      billedCostUsd: 99,
      inputTokens: 5000,
      model: 'gpt-5.2',
      outputTokens: 5000,
      provider: 'openai',
      resourceId: 'workspace-a',
      rootId: null,
      runId: 'run-stale',
      threadId: thread.id,
    });
    await db.query(
      `UPDATE brainstrike_assistant_run_usage
       SET created_at = NOW() - INTERVAL '25 hours'
       WHERE run_id = $1`,
      ['run-stale']
    );
    // Foreign workspace: excluded by the resource scope.
    await repository.recordRunUsage({
      billedCostUsd: 7,
      inputTokens: 10,
      model: 'gpt-5.2',
      outputTokens: 10,
      provider: 'openai',
      resourceId: 'workspace-b',
      rootId: null,
      runId: 'run-foreign',
      threadId: thread.id,
    });

    const liveSurface = db as unknown as LiveQuerySurface;
    if (!liveSurface.live) {
      throw new Error('Test PGlite is missing the live extension');
    }
    const handle = await liveSurface.live.query({
      params: ['workspace-a'],
      query: DAILY_SPEND_AGGREGATION_SQL,
    });
    try {
      const rows = handle.initialResults.rows.map(mapDailySpendUsageRow);
      expect(rows).toEqual([
        {
          billedCostUsd: 1.25,
          model: 'gpt-5.2',
          provider: 'openai',
          unreportedCacheCreationTokens: 0,
          unreportedCacheReadTokens: 0,
          unreportedInputTokens: 1000,
          unreportedOutputTokens: 200,
        },
      ]);
    } finally {
      await handle.unsubscribe();
    }
  });

  it('persists Anthropic cache token classes and surfaces them in the aggregation', async () => {
    pgliteDataDir = createPgliteTestDataDir('assistant-daily-spend-cache');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await repository.recordRunUsage({
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 600,
      inputTokens: 1000,
      model: 'claude-sonnet-4-6',
      outputTokens: 50,
      provider: 'anthropic',
      resourceId: 'workspace-a',
      rootId: null,
      runId: 'run-cached',
      threadId: thread.id,
    });

    const result = await db.query<Record<string, unknown>>(DAILY_SPEND_AGGREGATION_SQL, [
      'workspace-a',
    ]);
    expect(result.rows.map(mapDailySpendUsageRow)).toEqual([
      {
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        unreportedCacheCreationTokens: 200,
        unreportedCacheReadTokens: 600,
        unreportedInputTokens: 1000,
        unreportedOutputTokens: 50,
      },
    ]);

    // A row whose cache classes exceed the total is rejected at the write
    // boundary — it would poison every downstream estimate.
    await expect(
      repository.recordRunUsage({
        cacheCreationInputTokens: 900,
        cacheReadInputTokens: 200,
        inputTokens: 1000,
        model: 'claude-sonnet-4-6',
        outputTokens: 50,
        provider: 'anthropic',
        resourceId: 'workspace-a',
        rootId: null,
        runId: 'run-invalid',
        threadId: thread.id,
      })
    ).rejects.toThrow(/exceed/i);
  });
});
