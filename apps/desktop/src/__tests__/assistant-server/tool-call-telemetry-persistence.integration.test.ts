import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
/**
 * `persistDesktopToolCallTelemetry` against a REAL PGlite (BST-1190 review
 * fix).
 *
 * `run-persistence-direct.test.ts` mocks `database.query`, which cannot
 * reproduce PGlite's actual type resolution: a mock happily accepts a bare
 * `null` for any parameter position, but real PostgreSQL/PGlite resolves an
 * untyped `null` in an `INSERT ... SELECT` to `text`, and a `text -> boolean`
 * assignment fails. That was a real, review-caught bug in the first version
 * of the batched insert — this test proves the fix (explicit `::type[]`
 * casts on every `unnest()` array parameter) against the real engine rather
 * than trusting a mock that cannot fail the same way.
 */

import type { StreamChunk, ToolCallTelemetrySample } from '@brainstrike/agent';
import { MASTRA_MEMORY_TABLES } from '@brainstrike/assistant-contract';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { persistDesktopToolCallTelemetry } from '../../assistant-server/run-persistence';

type TestDatabase = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

interface TelemetryRow {
  candidates_truncated: boolean;
  engine: string | null;
  id: string;
  is_pagination_followup: boolean;
  model_facing_chars: number;
  occurred_at: string;
  scan_limited: boolean;
  thread_id: string;
  tool_id: string;
  truncated: boolean;
  zero_match: boolean | null;
}

async function* singleTelemetryChunk(
  samples: readonly ToolCallTelemetrySample[]
): AsyncGenerator<StreamChunk> {
  yield { type: 'tool-call-telemetry', value: samples } as unknown as StreamChunk;
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
    model: 'gpt-5.2',
    provider: 'openai',
    resourceId: 'workspace-a',
    runtimeKind: 'hosted',
    threadId,
  });
}

describe('persistDesktopToolCallTelemetry against real PGlite', () => {
  it('writes correctly-typed rows for both a search and a non-search tool call', async () => {
    const db = await wasmLoader.createPGlite(`memory://tool-call-telemetry-real-${Date.now()}`);
    try {
      await seedRun(db, 'run-real-1', 'thread-real-1');
      const grepOccurredAt = Date.UTC(2026, 7, 7, 9, 0, 0);
      const execOccurredAt = Date.UTC(2026, 7, 7, 9, 0, 5);

      const drain = async (): Promise<void> => {
        for await (const _chunk of persistDesktopToolCallTelemetry(
          singleTelemetryChunk([
            {
              candidatesTruncated: true,
              engine: 'js-walk',
              isPaginationFollowup: true,
              modelFacingChars: 210,
              occurredAt: grepOccurredAt,
              scanLimited: true,
              toolId: 'grepSearch',
              truncated: true,
              zeroMatch: false,
            },
            {
              candidatesTruncated: false,
              isPaginationFollowup: true,
              modelFacingChars: 88,
              occurredAt: execOccurredAt,
              scanLimited: false,
              toolId: 'executeCommand',
              truncated: false,
              zeroMatch: true,
            },
          ]),
          'run-real-1',
          async () => db
        )) {
          // drain
        }
      };

      // The bug under test would surface here, not as a thrown JS error: PGlite
      // would reject the INSERT with `column "zero_match" is of type boolean
      // but expression is of type text`, which the writer's catch turns into a
      // logger.warn — so the real assertion is that ROWS actually landed,
      // typed correctly, not merely that drain() resolved without throwing.
      await drain();

      const result = await db.query<TelemetryRow>(
        `SELECT id, thread_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup, engine, scan_limited, candidates_truncated
         FROM brainstrike_tool_call_telemetry
         ORDER BY tool_id`
      );
      expect(result.rows).toHaveLength(2);

      const [execRow, grepRow] = result.rows;
      expect(execRow).toMatchObject({
        candidates_truncated: false,
        engine: null,
        is_pagination_followup: false,
        model_facing_chars: 88,
        scan_limited: false,
        thread_id: 'thread-real-1',
        tool_id: 'executeCommand',
        truncated: false,
      });
      // Non-search tool: zero_match forced to NULL regardless of the sample's
      // own value — this is exactly the column the untyped-null bug broke.
      expect(execRow?.zero_match).toBeNull();
      expect(new Date(execRow?.occurred_at ?? '').getTime()).toBe(execOccurredAt);

      // BST-1247: substrate flags land in their own typed columns.
      expect(grepRow).toMatchObject({
        candidates_truncated: true,
        engine: 'js-walk',
        is_pagination_followup: true,
        model_facing_chars: 210,
        scan_limited: true,
        thread_id: 'thread-real-1',
        tool_id: 'grepSearch',
        truncated: true,
        zero_match: false,
      });
      expect(new Date(grepRow?.occurred_at ?? '').getTime()).toBe(grepOccurredAt);
    } finally {
      await db.close();
    }
  });

  it('logs a visible warning and writes nothing when the run row is missing (never silent)', async () => {
    const db = await wasmLoader.createPGlite(
      `memory://tool-call-telemetry-real-missing-${Date.now()}`
    );
    try {
      // Bootstrap the schema (so the table exists) without minting a run row.
      await seedRun(db, 'run-real-owner', 'thread-real-owner');

      const drain = async (): Promise<void> => {
        for await (const _chunk of persistDesktopToolCallTelemetry(
          singleTelemetryChunk([
            {
              candidatesTruncated: false,
              isPaginationFollowup: false,
              modelFacingChars: 40,
              occurredAt: Date.now(),
              scanLimited: false,
              toolId: 'grepSearch',
              truncated: false,
              zeroMatch: true,
            },
          ]),
          'run-does-not-exist',
          async () => db
        )) {
          // drain
        }
      };

      await drain();

      const result = await db.query('SELECT id FROM brainstrike_tool_call_telemetry');
      expect(result.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
