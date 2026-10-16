/**
 * Durable per-thread token usage: the SINK (Phase 5.1).
 *
 * The REAL desktop thread repository's `recordRunUsage` against a REAL PGlite
 * database, asserting the durable rows land and `getThreadCumulativeUsage`
 * aggregates them — including across TWO models, so per-model attribution
 * survives a mid-conversation model switch.
 *
 * This file used to obtain its usage numbers by driving the Mastra agent loop.
 * That loop was never part of the production path these numbers travel: the tap
 * is `buildUsageTap` in `packages/assistant-ui/src/data-stream-runtime.ts`,
 * which feeds `use-assistant-usage-ledger.ts`'s `recordRunUsage`. The loop was
 * a fixture for producing a usage pair, and it is retired (ADR-0022), so the
 * pairs are stated here instead. The two halves of the real path have their own
 * coverage: the tap in `packages/assistant-ui/src/__tests__/data-stream-runtime.test.ts`
 * and the ledger in
 * `packages/app-shell/src/assistant-panel/__tests__/use-assistant-usage-ledger.test.ts`.
 */
// The repository is exposed via the assistant-data package
// subpath (not its root barrel); the sink proof needs the REAL
// implementation. Interim placement — R04 (BST-984) moves this module into the
// data layer and the export moves with it.
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';

describe('durable run usage sink (real repo → real PGlite)', () => {
  it('persists provider usage and aggregates it per model', async () => {
    const dataDir = `memory://run-usage-sink-${Date.now()}`;
    const db = await wasmLoader.createPGlite(dataDir);
    await migrate(db);
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      const threadId = 'thread-usage-live';
      const resourceId = 'workspace-usage-live';

      // Turn 1 — model A (openai/gpt-5.2).
      const usageA = { inputTokens: 8, outputTokens: 4 };
      await repository.recordRunUsage({
        inputTokens: usageA.inputTokens,
        model: 'gpt-5.2',
        outputTokens: usageA.outputTokens,
        provider: 'openai',
        resourceId,
        runId: 'run-live-a',
        threadId,
      });

      // Turn 2 — same model A again.
      const usageA2 = { inputTokens: 10, outputTokens: 6 };
      await repository.recordRunUsage({
        inputTokens: usageA2.inputTokens,
        model: 'gpt-5.2',
        outputTokens: usageA2.outputTokens,
        provider: 'openai',
        resourceId,
        runId: 'run-live-a2',
        threadId,
      });

      // Turn 3 — a DIFFERENT model B (anthropic), same thread: a mid-conversation switch.
      const usageB = { inputTokens: 20, outputTokens: 9 };
      await repository.recordRunUsage({
        inputTokens: usageB.inputTokens,
        model: 'claude-opus-4-8',
        outputTokens: usageB.outputTokens,
        provider: 'anthropic',
        resourceId,
        runId: 'run-live-b',
        threadId,
      });

      // The durable rows landed and the cumulative aggregate sums them.
      const cumulative = await repository.getThreadCumulativeUsage(threadId);
      expect(cumulative).not.toBeNull();
      expect(cumulative?.totalInputTokens).toBe(8 + 10 + 20);
      expect(cumulative?.totalOutputTokens).toBe(4 + 6 + 9);

      // Per-model attribution survives the model switch.
      const byModel = new Map(
        (cumulative?.perModel ?? []).map((entry) => [`${entry.provider}:${entry.model}`, entry])
      );
      expect(byModel.get('openai:gpt-5.2')).toEqual({
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        inputTokens: 18,
        model: 'gpt-5.2',
        outputTokens: 10,
        provider: 'openai',
        runKind: 'chat',
      });
      expect(byModel.get('anthropic:claude-opus-4-8')).toEqual({
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedCacheReadTokens: 0,
        inputTokens: 20,
        model: 'claude-opus-4-8',
        outputTokens: 9,
        provider: 'anthropic',
        runKind: 'chat',
      });
    } finally {
      await db.close();
      expect(db.closed).toBe(true);
    }
  });
});
