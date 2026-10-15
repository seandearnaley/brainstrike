/**
 * LIVE-loop coverage for durable per-thread token usage (Phase 5.1).
 *
 * This is the load-bearing proof for the usage SINK: it drives the REAL Mastra
 * agent loop (`streamMastraAgent`) with a scripted model that emits REAL
 * provider usage on its `finish` parts, taps the resulting `message-finish`
 * chunk exactly the way the production usage tap does (`buildUsageTap` reads the
 * same chunk), and forwards that usage to the REAL desktop thread repository's
 * `recordRunUsage` against a REAL PGlite database. It then asserts the durable
 * row(s) land and `getThreadCumulativeUsage` aggregates them — including across
 * TWO models, proving per-model attribution survives.
 *
 * Mocked-only stream tests have previously stayed green while the real loop
 * broke (see CLAUDE.md ASSISTANT RESILIENCE), so this exercises the actual
 * agent loop end to end: only the language model (scripted through
 * `modelOverride` — no API key, no network) and the Electron/db surfaces the
 * desktop setup stubs are scripted. The repository, its schema bootstrap, and the SQL aggregate are
 * all real.
 */
// The repository is exposed via the assistant-data package
// subpath (not its root barrel); the live-loop proof needs the REAL
// implementation. Interim placement — R04 (BST-984) moves this module into the
// data layer and the export moves with it.
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it, vi } from 'vitest';
import { createScriptedChatModel, scriptedLoopOptions } from './_scripted-chat-model';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

/**
 * Run one real turn through the Mastra loop and return the provider usage as the
 * production tap surfaces it: from the `message-finish` chunk, mapped from
 * {promptTokens, completionTokens} → {inputTokens, outputTokens}.
 */
async function runTurnAndCaptureUsage(args: {
  promptTokens: number;
  completionTokens: number;
}): Promise<{ inputTokens: number; outputTokens: number }> {
  // No tool calls — this turn measures usage, not tool execution.
  const model = createScriptedChatModel(() => ({
    chunks: ['Hi.'],
    kind: 'text',
    usage: { inputTokens: args.promptTokens, outputTokens: args.completionTokens },
  }));

  const iterator = await streamMastraAgent(
    [{ id: 'u-usage', parts: [{ text: 'say hi', type: 'text' }], role: 'user' }],
    scriptedLoopOptions(model)
  );

  let captured: { inputTokens: number; outputTokens: number } | null = null;
  for await (const chunk of iterator) {
    // The production usage tap reads exactly this chunk (see buildUsageTap).
    if (chunk.type === 'message-finish') {
      const usage = (chunk as { usage?: { promptTokens?: number; completionTokens?: number } })
        .usage;
      if (usage && (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) > 0) {
        captured = {
          inputTokens: usage.promptTokens ?? 0,
          outputTokens: usage.completionTokens ?? 0,
        };
      }
    }
  }

  if (!captured) {
    throw new Error('Real Mastra loop did not surface non-zero usage on message-finish');
  }
  return captured;
}

describe('durable run usage live Mastra loop (real agent → real repo → real PGlite)', () => {
  it('persists provider usage from a real turn and aggregates it per model', async () => {
    const dataDir = `memory://run-usage-live-loop-${Date.now()}`;
    const db = await wasmLoader.createPGlite(dataDir);
    await migrate(db);
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      const threadId = 'thread-usage-live';
      const resourceId = 'workspace-usage-live';

      // Turn 1 — model A (openai/gpt-5.2). REAL loop emits usage {8, 4}.
      const usageA = await runTurnAndCaptureUsage({ completionTokens: 4, promptTokens: 8 });
      expect(usageA).toEqual({ inputTokens: 8, outputTokens: 4 });
      await repository.recordRunUsage({
        inputTokens: usageA.inputTokens,
        model: 'gpt-5.2',
        outputTokens: usageA.outputTokens,
        provider: 'openai',
        resourceId,
        runId: 'run-live-a',
        threadId,
      });

      // Turn 2 — same model A again {10, 6}.
      const usageA2 = await runTurnAndCaptureUsage({ completionTokens: 6, promptTokens: 10 });
      await repository.recordRunUsage({
        inputTokens: usageA2.inputTokens,
        model: 'gpt-5.2',
        outputTokens: usageA2.outputTokens,
        provider: 'openai',
        resourceId,
        runId: 'run-live-a2',
        threadId,
      });

      // Turn 3 — a DIFFERENT model B (anthropic) {20, 9} — same thread, mid-conversation switch.
      const usageB = await runTurnAndCaptureUsage({ completionTokens: 9, promptTokens: 20 });
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
