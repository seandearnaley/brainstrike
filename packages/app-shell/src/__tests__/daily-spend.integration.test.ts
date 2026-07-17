import type { DbHandle } from '@brainstrike/db';
import { wasmLoader } from '@brainstrike/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteAssistantThreadRepository } from '../assistant-memory-repository';
import { DAILY_SPEND_AGGREGATION_SQL, mapDailySpendUsageRow } from '../cost-tracking/daily-spend';

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

  afterEach(async () => {
    if (pgliteDataDir) {
      await wasmLoader.closeCached(pgliteDataDir);
      pgliteDataDir = undefined;
    }
  });

  it('is consumable through live.query and windows to the rolling last 24 hours', async () => {
    // The budget guardrail consumes DAILY_SPEND_AGGREGATION_SQL through
    // PGlite's live extension, whose format() rewrite breaks on repeated bind
    // parameters — same regression class pinned for RUN_LEDGER_AGGREGATION_SQL.
    pgliteDataDir = createPgliteTestDataDir('assistant-daily-spend-live');
    const db = await wasmLoader.createPGlite(pgliteDataDir);
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
          unreportedInputTokens: 1000,
          unreportedOutputTokens: 200,
        },
      ]);
    } finally {
      await handle.unsubscribe();
    }
  });
});
