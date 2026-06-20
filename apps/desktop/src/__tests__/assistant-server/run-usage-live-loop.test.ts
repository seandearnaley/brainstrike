/**
 * LIVE-loop coverage for durable per-thread token usage (Phase 5.1).
 *
 * This is the load-bearing proof for the usage SINK: it drives the REAL Mastra
 * agent loop (`streamMastraAgent`) with a scripted local host client that emits
 * REAL provider usage on its `finish` parts, taps the resulting `message-finish`
 * chunk exactly the way the production usage tap does (`buildUsageTap` reads the
 * same chunk), and forwards that usage to the REAL desktop thread repository's
 * `recordRunUsage` against a REAL PGlite database. It then asserts the durable
 * row(s) land and `getThreadCumulativeUsage` aggregates them — including across
 * TWO models, proving per-model attribution survives.
 *
 * Mocked-only stream tests have previously stayed green while the real loop
 * broke (see CLAUDE.md ASSISTANT RESILIENCE), so this exercises the actual
 * agent loop end to end: only the language model (a scripted local host client,
 * no API key, no network) and the Electron/db surfaces the desktop setup stubs
 * are scripted. The repository, its schema bootstrap, and the SQL aggregate are
 * all real.
 */
import type { RuntimeData } from '@brainstrike/agent';
import type {
  LocalLlmGenerationResult,
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
  LocalLlmHostRequestOptions,
} from '@brainstrike/agent/local-llm';
import { type DbHandle, wasmLoader } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
// The repository is internal to @brainstrike/app-shell (not on its barrel); the
// live-loop proof needs the REAL implementation, so it imports the source
// module directly. The repo's runtime imports (assistant-contract subpaths, db)
// resolve through the workspace like every other desktop test dependency.
import { createPgliteAssistantThreadRepository } from '../../../../../packages/app-shell/src/assistant-memory-repository';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

/**
 * A trivial scripted host client that streams a short answer and returns the
 * supplied usage. No tool calls — this turn measures usage, not tool execution.
 */
function createUsageHostClient(usage: {
  promptTokens: number;
  completionTokens: number;
}): LocalLlmHostClient {
  return {
    warmup: vi.fn().mockResolvedValue(undefined),
    generate: (
      _request: LocalLlmHostGenerateRequest,
      options: LocalLlmHostRequestOptions = {}
    ): Promise<LocalLlmGenerationResult> => {
      options.onProgress?.({ kind: 'text', text: 'Hi.' });
      return Promise.resolve({
        text: 'Hi.',
        finishReason: 'stop',
        usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens },
      });
    },
  };
}

/**
 * Run one real turn through the Mastra loop and return the provider usage as the
 * production tap surfaces it: from the `message-finish` chunk, mapped from
 * {promptTokens, completionTokens} → {inputTokens, outputTokens}.
 */
async function runTurnAndCaptureUsage(args: {
  promptTokens: number;
  completionTokens: number;
}): Promise<{ inputTokens: number; outputTokens: number }> {
  const hostClient = createUsageHostClient({
    promptTokens: args.promptTokens,
    completionTokens: args.completionTokens,
  });

  const iterator = await streamMastraAgent(
    [{ id: 'u-usage', role: 'user', parts: [{ type: 'text', text: 'say hi' }] }],
    {
      runtime: {
        provider: 'local',
        model: 'onnx-community/gemma-4-E2B-it-ONNX',
        localLlmHostClient: hostClient,
        providerOptions: { local: { thinking: { enabled: false } } },
      } as RuntimeData,
    }
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
    try {
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      const threadId = 'thread-usage-live';
      const resourceId = 'workspace-usage-live';

      // Turn 1 — model A (openai/gpt-5.2). REAL loop emits usage {8, 4}.
      const usageA = await runTurnAndCaptureUsage({ promptTokens: 8, completionTokens: 4 });
      expect(usageA).toEqual({ inputTokens: 8, outputTokens: 4 });
      await repository.recordRunUsage({
        threadId,
        runId: 'run-live-a',
        resourceId,
        model: 'gpt-5.2',
        provider: 'openai',
        inputTokens: usageA.inputTokens,
        outputTokens: usageA.outputTokens,
      });

      // Turn 2 — same model A again {10, 6}.
      const usageA2 = await runTurnAndCaptureUsage({ promptTokens: 10, completionTokens: 6 });
      await repository.recordRunUsage({
        threadId,
        runId: 'run-live-a2',
        resourceId,
        model: 'gpt-5.2',
        provider: 'openai',
        inputTokens: usageA2.inputTokens,
        outputTokens: usageA2.outputTokens,
      });

      // Turn 3 — a DIFFERENT model B (anthropic) {20, 9} — same thread, mid-conversation switch.
      const usageB = await runTurnAndCaptureUsage({ promptTokens: 20, completionTokens: 9 });
      await repository.recordRunUsage({
        threadId,
        runId: 'run-live-b',
        resourceId,
        model: 'claude-opus-4-8',
        provider: 'anthropic',
        inputTokens: usageB.inputTokens,
        outputTokens: usageB.outputTokens,
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
        provider: 'openai',
        model: 'gpt-5.2',
        inputTokens: 18,
        outputTokens: 10,
      });
      expect(byModel.get('anthropic:claude-opus-4-8')).toEqual({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: 20,
        outputTokens: 9,
      });
    } finally {
      await wasmLoader.closeCached(dataDir);
    }
  });
});
