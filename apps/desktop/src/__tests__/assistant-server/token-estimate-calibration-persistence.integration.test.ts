import type { StreamChunk, TokenEstimateCalibrationSample } from '@brainstrike/agent';
import { MASTRA_MEMORY_SCHEMA_SQL, MASTRA_MEMORY_TABLES } from '@brainstrike/assistant-contract';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { persistDesktopTokenEstimateCalibration } from '../../assistant-server/run-persistence';

type TestDatabase = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

interface CalibrationRow {
  estimated_prompt_tokens: number;
  model: string;
  occurred_at: string;
  provider: string;
  provider_reported_prompt_tokens: number;
  run_id: string;
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
  await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
  await db.query(
    `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [threadId, 'workspace-a', 'Seeded thread', JSON.stringify({}), new Date(), new Date()]
  );
  const repository = createPgliteAssistantThreadRepository(db as DbHandle);
  await repository.createThreadRun({
    id: runId,
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
      await seedRun(db, 'run-calibration-1', 'thread-calibration-1');
      const occurredAt = Date.UTC(2026, 7, 8, 12, 0, 0);

      await drain(db, 'run-calibration-1', {
        estimatedPromptTokens: 321,
        model: 'gpt-5.6-terra',
        occurredAt,
        provider: 'openai',
        providerReportedPromptTokens: 456,
      });

      const result = await db.query<CalibrationRow>(
        `SELECT thread_id, run_id, model, provider, estimated_prompt_tokens,
                provider_reported_prompt_tokens, occurred_at
           FROM brainstrike_token_estimate_calibration`
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        estimated_prompt_tokens: 321,
        model: 'gpt-5.6-terra',
        provider: 'openai',
        provider_reported_prompt_tokens: 456,
        run_id: 'run-calibration-1',
        thread_id: 'thread-calibration-1',
      });
      expect(new Date(result.rows[0]?.occurred_at ?? '').getTime()).toBe(occurredAt);
    } finally {
      await db.close();
    }
  });

  it.each([
    'missing provider usage',
    'failed measurement',
  ])('writes zero rows when emission omitted the sample for %s', async () => {
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
  });
});
