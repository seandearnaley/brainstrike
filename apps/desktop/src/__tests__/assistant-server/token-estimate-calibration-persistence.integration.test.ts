import type { StreamChunk, TokenEstimateCalibrationSample } from '@brainstrike/agent';
import { MASTRA_MEMORY_TABLES } from '@brainstrike/assistant-contract';
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { persistDesktopTokenEstimateCalibration } from '../../assistant-server/run-persistence';

type TestDatabase = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

interface CalibrationRow {
  estimated_prompt_tokens: number;
  final_step_prompt_tokens: number;
  model: string;
  model_visible_projection_count: number;
  occurred_at: string;
  prompt_baseline_tokens: number | null;
  provider: string;
  resolved_domain_budget_tokens: number | null;
  resolved_transport_budget_tokens: number | null;
  run_id: string;
  step_count: number;
  thread_id: string;
}

async function* calibrationStream(
  sample: TokenEstimateCalibrationSample | undefined
): AsyncGenerator<StreamChunk> {
  if (sample) {
    yield { type: 'token-estimate-calibration', value: sample } as StreamChunk;
  }
}

async function seedRun(db: TestDatabase, runId: string, threadId: string): Promise<void> {
  // Migrations 117/118 own the assistant schema; the repository probes for
  // it rather than creating it (BST-1651).
  await migrate(db);
  await db.query(
    `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [threadId, 'workspace-a', 'Seeded thread', JSON.stringify({}), new Date(), new Date()]
  );
  const repository = createPgliteAssistantThreadRepository(db as DbHandle);
  await repository.createThreadRun({
    id: runId as HostRunId,
    model: 'gpt-5.6-terra',
    provider: 'openai',
    resourceId: 'workspace-a',
    runtimeKind: 'hosted',
    threadId,
  });
}

async function drain(
  db: TestDatabase,
  runId: string,
  sample: TokenEstimateCalibrationSample | undefined
): Promise<void> {
  for await (const _chunk of persistDesktopTokenEstimateCalibration(
    calibrationStream(sample),
    runId,
    async () => db
  )) {
    // Internal calibration chunks are consumed by the persistence wrapper.
  }
}

describe('persistDesktopTokenEstimateCalibration against real PGlite', () => {
  it('persists one run-attributed calibration row with no content fields', async () => {
    const db = await wasmLoader.createPGlite(`memory://token-calibration-real-${Date.now()}`);
    try {
      await migrate(db);
      await seedRun(db, 'run-calibration-1', 'thread-calibration-1');
      const occurredAt = Date.UTC(2026, 7, 8, 12, 0, 0);

      await drain(db, 'run-calibration-1', {
        estimatedPromptTokens: 321,
        finalStepPromptTokens: 456,
        model: 'gpt-5.6-terra',
        modelVisibleProjectionCount: 3,
        occurredAt,
        promptBreakdownBaselineTokens: 9876,
        provider: 'openai',
        resolvedDomainBudgetTokens: 1500,
        resolvedTransportBudgetTokens: 3000,
        stepCount: 4,
      });

      const result = await db.query<CalibrationRow>(
        `SELECT thread_id, run_id, model, provider, estimated_prompt_tokens,
                final_step_prompt_tokens, step_count, model_visible_projection_count,
                resolved_domain_budget_tokens, resolved_transport_budget_tokens,
                prompt_baseline_tokens, occurred_at
           FROM brainstrike_token_estimate_calibration`
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        estimated_prompt_tokens: 321,
        final_step_prompt_tokens: 456,
        model: 'gpt-5.6-terra',
        model_visible_projection_count: 3,
        prompt_baseline_tokens: 9876,
        provider: 'openai',
        resolved_domain_budget_tokens: 1500,
        resolved_transport_budget_tokens: 3000,
        run_id: 'run-calibration-1',
        step_count: 4,
        thread_id: 'thread-calibration-1',
      });
      expect(new Date(result.rows[0]?.occurred_at ?? '').getTime()).toBe(occurredAt);
    } finally {
      await db.close();
    }
  });

  it('persists NULL budget columns for a backward-compatible sample without tier data', async () => {
    const db = await wasmLoader.createPGlite(
      `memory://token-calibration-null-tier-${crypto.randomUUID()}`
    );
    try {
      await migrate(db);
      await seedRun(db, 'run-calibration-null-tier', 'thread-calibration-null-tier');
      await drain(db, 'run-calibration-null-tier', {
        estimatedPromptTokens: 10,
        finalStepPromptTokens: 20,
        model: 'legacy-model',
        modelVisibleProjectionCount: 1,
        occurredAt: Date.UTC(2026, 7, 8, 13, 0, 0),
        provider: 'openai',
        stepCount: 1,
      });

      const result = await db.query<{
        prompt_baseline_tokens: number | null;
        resolved_domain_budget_tokens: number | null;
        resolved_transport_budget_tokens: number | null;
      }>(
        `SELECT resolved_domain_budget_tokens, resolved_transport_budget_tokens,
                prompt_baseline_tokens
         FROM brainstrike_token_estimate_calibration`
      );
      expect(result.rows).toEqual([
        {
          prompt_baseline_tokens: null,
          resolved_domain_budget_tokens: null,
          resolved_transport_budget_tokens: null,
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it.each(['missing provider usage', 'failed measurement'])(
    'writes zero rows when emission omitted the sample for %s',
    async () => {
      const db = await wasmLoader.createPGlite(
        `memory://token-calibration-omitted-${crypto.randomUUID()}`
      );
      try {
        await seedRun(db, 'run-calibration-omitted', 'thread-calibration-omitted');
        await drain(db, 'run-calibration-omitted', undefined);

        const result = await db.query('SELECT id FROM brainstrike_token_estimate_calibration');
        expect(result.rows).toHaveLength(0);
      } finally {
        await db.close();
      }
    }
  );
});
