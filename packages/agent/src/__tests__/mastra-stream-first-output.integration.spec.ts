/**
 * BST-1408: the provider's time-to-first-output gets its own budget, PER STEP.
 *
 * This file drives the REAL `@mastra/core` loop instead of the shared
 * fake-Mastra harness, and that is the whole point of it existing: the harness
 * feeds a hand-written part list, so it structurally cannot reproduce Mastra's
 * framework PROLOGUE — and the prologue is exactly what makes a naive
 * "first part wins" rule guard nothing.
 *
 * Measured ordering through the real loop (probe, review of #2586):
 *
 *   part#1 start       t+0ms     part#6 step-start t+321ms
 *   part#2 step-start  t+7ms     part#7 text-start t+723ms   <- 402ms TTFT
 *   part#3 tool-call   t+312ms                               <- 305ms TTFT
 *
 * Two consequences, both load-bearing:
 *  1. `start` arrives instantly, so a window that ends at the first RAW part
 *     covers ~0ms of provider time.
 *  2. Mastra emits a fresh `step-start` for every step, so time-to-first-output
 *     RECURS. The captured incident's fatal gap was a mid-turn step's TTFT
 *     (`run.step.started` 07:51:41 -> silence -> killed 07:56:48), not the
 *     opening one.
 *
 * Uncached integration lane: verdicts depend on real timer progress.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'gpt-5.6-terra',
  };
});

const { streamMastraAgent } = await import('../mastra/agent-streaming');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
const TOOL_ID = 'brainstrike_grepSearch';

/**
 * A provider stream that exists immediately but emits nothing for `delayMs` —
 * a real time-to-first-token, as opposed to a slow transport.
 */
function enqueueAfter(
  delayMs: number,
  parts: LanguageModelV2StreamPart[]
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function promptHasToolResult(options: LanguageModelV2CallOptions): boolean {
  return Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
}

/** Both steps think for `ttftMs` before emitting anything, then stream fast. */
function slowFirstTokenModel(ttftMs: number): LanguageModelV2 {
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) =>
      Promise.resolve({
        stream: promptHasToolResult(options)
          ? enqueueAfter(ttftMs, [
              { type: 'stream-start', warnings: [] },
              { id: 'f', type: 'text-start' },
              { delta: 'SLOW_ANSWER', id: 'f', type: 'text-delta' },
              { id: 'f', type: 'text-end' },
              { finishReason: 'stop', type: 'finish', usage: USAGE },
            ])
          : enqueueAfter(ttftMs, [
              { type: 'stream-start', warnings: [] },
              {
                input: JSON.stringify({ pattern: 'flag' }),
                toolCallId: 'call-1',
                toolName: TOOL_ID,
                type: 'tool-call',
              },
              { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
            ]),
      }),
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

function searchTool() {
  return createTool({
    description: 'Search the workspace for a pattern.',
    execute: () => Promise.resolve({ matches: ['found'] }),
    id: TOOL_ID,
    inputSchema: z.object({ pattern: z.string() }),
    outputSchema: z.object({ matches: z.array(z.string()) }),
  });
}

async function runTurn(): Promise<StreamChunk[]> {
  const iterator = await streamMastraAgent(
    [{ id: 'u1', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
    {
      runtime: { apiKey: 'test-key', provider: 'openai' },
      tools: { 'brainstrike.grepSearch': searchTool() },
    }
  );
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return chunks;
}

function runEventKinds(chunks: readonly StreamChunk[]): string[] {
  return chunks
    .filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
    )
    .map((chunk) => chunk.event.kind);
}

function textOf(chunks: readonly StreamChunk[]): string {
  return chunks
    .filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta'
    )
    .map((chunk) => chunk.value)
    .join('');
}

const ENV_KEYS = [
  'BRAINSTRIKE_TOOL_TIMEOUT_MS',
  'BRAINSTRIKE_STREAM_INACTIVITY_MS',
  'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS',
] as const;

describe('per-step first-output budget (real Mastra loop)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '50';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('lets every step think past the inter-output window before it emits anything', async () => {
    // 300ms of provider silence per step against a 60ms inter-output window.
    // Only a budget that re-arms at each `step-start` can finish this turn;
    // ~13x headroom on the first-output window, since this half asserts a
    // NEGATIVE (must NOT trip) and only slowness can break it.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '60';
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '4000';
    modelHolder.current = slowFirstTokenModel(300);

    const chunks = await runTurn();

    expect(runEventKinds(chunks)).toContain('run.finished');
    expect(runEventKinds(chunks)).not.toContain('run.failed');
    expect(textOf(chunks)).toContain('SLOW_ANSWER');
  }, 30_000);

  it('still fails a step that never produces output within its own budget', async () => {
    // The budget stays finite: a provider that never answers cannot hold a turn
    // open forever just because the phase re-armed.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '60';
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '120';
    modelHolder.current = slowFirstTokenModel(3000);

    const chunks = await runTurn();
    const failure = chunks.find(
      (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
        chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );

    expect(failure?.event.metadata).toEqual(
      expect.objectContaining({
        code: 'stream_inactivity_timeout',
        inactivityMs: 120,
        phase: 'awaiting-output',
      })
    );
    // The prologue arrived, so the breadcrumb names it rather than reporting a
    // stream that produced literally nothing.
    expect(failure?.event.metadata?.['lastPartType']).toBe('step-start');
  }, 30_000);
});
