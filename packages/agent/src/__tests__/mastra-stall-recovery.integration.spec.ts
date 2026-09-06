/**
 * BST-1409: a stalled provider attempt must end the ATTEMPT, not the TURN.
 *
 * Drives the REAL `streamMastraAgent` → real Mastra agent loop → real tool
 * `execute` path against a scripted `LanguageModelV2`, so the recovery is
 * exercised through the same seam production uses. The integration suffix keeps
 * these in the uncached lane: their verdicts depend on the inactivity
 * watchdog's real timer progress (docs/agents/assistant-runtime.md).
 *
 * The load-bearing assertion in every recovery case is the tool-execution
 * COUNT. A continuation that lost the first attempt's completed steps would
 * still produce a plausible final answer — it would simply re-run every tool
 * first. Only the count proves the work carried forward.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
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

function enqueue(parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

/** A stream that never enqueues and never closes: the transport gone silent. */
function silentStream(): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start() {
      // Intentionally empty.
    },
  });
}

function toolCallStream(toolCallId: string, pattern: string): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { input: JSON.stringify({ pattern }), toolCallId, toolName: TOOL_ID, type: 'tool-call' },
    { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
  ];
}

function finalTextStream(text: string): LanguageModelV2StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 'final', type: 'text-start' },
    { delta: text, id: 'final', type: 'text-delta' },
    { id: 'final', type: 'text-end' },
    { finishReason: 'stop', type: 'finish', usage: USAGE },
  ];
}

function promptHasToolResult(options: LanguageModelV2CallOptions): boolean {
  return Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
}

/**
 * Step 1 calls a tool. The step AFTER the tool result goes silent `stallCount`
 * times, then answers. Mirrors the captured incident: real progress, then a gap.
 */
function stallThenAnswerModel(stallCount: number): {
  model: LanguageModelV2;
  promptsSeen: LanguageModelV2CallOptions[];
} {
  const promptsSeen: LanguageModelV2CallOptions[] = [];
  let stallsRemaining = stallCount;
  return {
    model: {
      doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
      doStream: (options: LanguageModelV2CallOptions) => {
        promptsSeen.push(options);
        if (!promptHasToolResult(options)) {
          return Promise.resolve({ stream: enqueue(toolCallStream('call-1', 'flag')) });
        }
        if (stallsRemaining > 0) {
          stallsRemaining -= 1;
          return Promise.resolve({ stream: silentStream() });
        }
        return Promise.resolve({ stream: enqueue(finalTextStream('ANSWER: FLAG-42')) });
      },
      modelId: 'fake-model',
      provider: 'fake',
      specificationVersion: 'v2',
      supportedUrls: {},
    },
    promptsSeen,
  };
}

const DELEGATION_TOOL = 'agent-explore';

const testPersona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Explore the workspace and report findings.',
  id: 'explore',
  instructions: 'You are the Explorer subagent.',
  label: 'Explorer',
  maxSteps: 4,
};

function toolNamesOf(options: LanguageModelV2CallOptions): string[] {
  const tools = (options as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) =>
      tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined
    )
    .filter((name): name is string => typeof name === 'string');
}

/** Parent delegates; the CHILD's stream never emits, hanging the delegation. */
function stalledChildModel(): LanguageModelV2 {
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      if (toolNamesOf(options).includes(DELEGATION_TOOL)) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify({ prompt: 'survey' }),
              toolCallId: 'delegation-call-1',
              toolName: DELEGATION_TOOL,
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      return Promise.resolve({ stream: silentStream() });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

interface Collected {
  chunks: StreamChunk[];
  finalText: string;
  runEvents: Array<{ kind: string; metadata?: Record<string, unknown>; status?: string }>;
}

async function collect(iterator: AsyncIterable<StreamChunk>): Promise<Collected> {
  const runEvents: Array<{ kind: string; metadata?: Record<string, unknown>; status?: string }> =
    [];
  const chunks: StreamChunk[] = [];
  let finalText = '';
  for await (const chunk of iterator) {
    chunks.push(chunk);
    if (chunk.type === 'run-event') {
      runEvents.push({
        kind: chunk.event.kind,
        ...(chunk.event.metadata ? { metadata: chunk.event.metadata } : {}),
        status: chunk.event.status,
      });
    } else if (chunk.type === 'text-delta') {
      finalText += chunk.value;
    }
  }
  return { chunks, finalText, runEvents };
}

function makeTool(spy: (input: { pattern: string }) => Promise<{ matches: string[] }>) {
  return createTool({
    description: 'Search the workspace for a pattern.',
    execute: spy,
    id: TOOL_ID,
    inputSchema: z.object({ pattern: z.string() }),
    outputSchema: z.object({ matches: z.array(z.string()) }),
  });
}

const ENV_KEYS = [
  'BRAINSTRIKE_STREAM_INACTIVITY_MS',
  'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS',
  'BRAINSTRIKE_TOOL_TIMEOUT_MS',
  'BRAINSTRIKE_STREAM_STALL_ATTEMPTS',
] as const;

describe('stall recovery (real Mastra loop)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '50';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '150';
    // Every stall in this file lands in the `awaiting-output` phase: the model
    // opens its stream and produces nothing, and Mastra's `step-start` is
    // scaffolding, so the FIRST-OUTPUT window is the one that fires. Kept just
    // above the inactivity window (the invariant's floor) so these cases stay
    // fast rather than waiting out a production-sized budget.
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '200';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('continues the turn after one stall, without re-running the completed tool', async () => {
    const executeSpy = vi.fn((_input: { pattern: string }) =>
      Promise.resolve({ matches: ['found FLAG-42'] })
    );
    const { model } = stallThenAnswerModel(1);
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { 'brainstrike.grepSearch': makeTool(executeSpy) },
      }
    );
    const { finalText, runEvents } = await collect(iterator);
    const kinds = runEvents.map((event) => event.kind);

    // The turn completed rather than dying at the stall.
    expect(finalText).toContain('ANSWER: FLAG-42');
    expect(kinds).toContain('run.finished');
    expect(kinds).not.toContain('run.failed');

    // The stall and its continuation are both VISIBLE. Recovery that hides
    // itself is exactly the silent degradation this repo forbids.
    expect(kinds).toContain('run.stalled');
    expect(kinds).toContain('run.resumed');
    expect(kinds.indexOf('run.stalled')).toBeLessThan(kinds.indexOf('run.resumed'));

    // THE load-bearing assertion: the completed step carried forward. A
    // continuation that lost it would re-call the tool and still answer.
    expect(executeSpy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('carries the completed tool RESULT into the continuation prompt', async () => {
    const { model, promptsSeen } = stallThenAnswerModel(1);
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u2', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': makeTool(() => Promise.resolve({ matches: ['found FLAG-42'] })),
        },
      }
    );
    await collect(iterator);

    // Three model calls: initial tool-call step, the stalled step, the
    // continuation. The continuation must still carry the tool result — the
    // model cannot answer from a prompt that lost it.
    expect(promptsSeen.length).toBe(3);
    const continuation = promptsSeen.at(-1);
    expect(continuation && promptHasToolResult(continuation)).toBe(true);
    // And the original user turn, so the continuation is not an orphaned
    // fragment the model has to guess the purpose of.
    expect(JSON.stringify(continuation?.prompt)).toContain('find the flag');
  }, 30_000);

  it('fails terminally once the attempt budget is spent, keeping the visible reason', async () => {
    process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = '2';
    const executeSpy = vi.fn((_input: { pattern: string }) =>
      Promise.resolve({ matches: ['found'] })
    );
    // Stalls forever: recovery must not loop.
    const { model } = stallThenAnswerModel(Number.POSITIVE_INFINITY);
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u3', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: { 'brainstrike.grepSearch': makeTool(executeSpy) },
      }
    );
    const { finalText, runEvents } = await collect(iterator);
    const kinds = runEvents.map((event) => event.kind);

    expect(kinds.filter((kind) => kind === 'run.stalled')).toHaveLength(2);
    expect(kinds).toContain('run.failed');
    // Phase-specific copy: this step never started, so it must not read as
    // "was streaming, then stopped".
    expect(finalText).toContain('produced no output within 200ms');
  }, 30_000);

  it('does not recover when the budget is one attempt (opt-out is honoured)', async () => {
    process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = '1';
    const { model } = stallThenAnswerModel(1);
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u4', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': makeTool(() => Promise.resolve({ matches: ['found'] })),
        },
      }
    );
    const { runEvents } = await collect(iterator);
    const kinds = runEvents.map((event) => event.kind);

    expect(kinds).toContain('run.failed');
    expect(kinds).not.toContain('run.resumed');
  }, 30_000);

  it('never leaves an orphaned subagent.started behind a replaced attempt', async () => {
    // The repo already fixed this bug class once for cancelled parents: an
    // in-flight delegation whose parent stream ends MUST get a terminal event.
    // A recovery is a third way for a parent stream to end, so the same rule has
    // to hold per attempt — otherwise a recovered turn renders a delegation that
    // spins forever.
    modelHolder.current = stalledChildModel();

    const iterator = await streamMastraAgent(
      [{ id: 'u6', parts: [{ text: 'survey the workspace', type: 'text' }], role: 'user' }],
      {
        personas: [testPersona],
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': makeTool(() => Promise.resolve({ matches: ['found'] })),
        },
      }
    );
    const { runEvents } = await collect(iterator);

    // Both attempts delegated (the first produced no tool result to carry
    // forward, so the continuation legitimately delegates again).
    const started = runEvents.filter((event) => event.kind === 'subagent.started');
    expect(started).toHaveLength(2);
    // ...and BOTH were settled. One terminal per start, no orphan.
    const settled = runEvents.filter(
      (event) => event.kind === 'subagent.failed' || event.kind === 'subagent.finished'
    );
    expect(settled).toHaveLength(2);
  }, 30_000);

  it('reports ONE run.started for a recovered turn, and a full stall breadcrumb', async () => {
    // A continuation is a fresh `agent.stream`, so Mastra re-emits `start`.
    // Left alone, one turn shows two "Assistant run started" rows and every
    // started/finished aggregation double-counts recovered runs (review of
    // #2590). `run.resumed` is what marks the new attempt.
    const { model } = stallThenAnswerModel(1);
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u7', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': makeTool(() => Promise.resolve({ matches: ['found'] })),
        },
      }
    );
    const { runEvents } = await collect(iterator);

    expect(runEvents.filter((event) => event.kind === 'run.started')).toHaveLength(1);
    expect(runEvents.filter((event) => event.kind === 'run.resumed')).toHaveLength(1);

    // A RECOVERED stall is followed by no `run.failed`, so its `run.stalled` is
    // the only durable record — it must carry the whole BST-1408 breadcrumb.
    const stalled = runEvents.find((event) => event.kind === 'run.stalled');
    expect(stalled?.metadata).toEqual(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        phase: 'awaiting-output',
      })
    );
    expect(stalled?.metadata?.['lastPartType']).toBe('step-start');
  }, 30_000);

  it('bills a recovered turn for the stalled attempt too', async () => {
    // The stalled attempt really did spend tokens on a completed step. Starting
    // the continuation's counters at zero made every recovered turn
    // under-report to the run ledger and spend analytics (review of #2590).
    const { model } = stallThenAnswerModel(1);
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u8', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': makeTool(() => Promise.resolve({ matches: ['found'] })),
        },
      }
    );
    const { chunks } = await collect(iterator);
    const finish = chunks.find(
      (chunk): chunk is Extract<StreamChunk, { type: 'message-finish' }> =>
        chunk.type === 'message-finish'
    );

    // Exactly two billed steps across the turn: attempt 1's tool-call step, and
    // the continuation's answer. (Attempt 1's stalled step produced nothing and
    // reports no usage.) The scripted model bills 1 input + 1 output per step,
    // so the turn total is 2 — and it was 1 before this fix, because the
    // continuation's own finish is cumulative over ITS stream alone.
    expect(finish?.usage?.completionTokens).toBe(2);
    expect(finish?.usage?.promptTokens).toBe(2);
    // Context sizes describe the LATEST step's prompt, not the turn's spend, so
    // they must not accumulate — claiming a context window that never existed
    // would be worse than under-reporting it.
    expect(finish?.usage?.contextOutputTokens).toBe(1);
  }, 30_000);

  it('does not resurrect a turn the user cancelled during the stall', async () => {
    const controller = new AbortController();
    const { model } = stallThenAnswerModel(1);
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u5', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai', signal: controller.signal },
        tools: {
          'brainstrike.grepSearch': makeTool(() => {
            // Cancel as soon as the run is demonstrably in flight.
            controller.abort();
            return Promise.resolve({ matches: ['found'] });
          }),
        },
      }
    );
    const { runEvents } = await collect(iterator);
    const kinds = runEvents.map((event) => event.kind);

    // A user Stop is a decision, not a transport fault: never retried.
    expect(kinds).not.toContain('run.resumed');
  }, 30_000);
});
