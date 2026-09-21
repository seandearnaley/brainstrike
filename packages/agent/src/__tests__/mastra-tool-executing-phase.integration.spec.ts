/**
 * BST-1777 Task 9: the stream watchdog's `tool-executing` phase must actually
 * shield a silently-running tool from the provider-silence window, and the
 * `streaming` phase must still kill a genuinely stalled provider.
 *
 * Drives the REAL Mastra loop (`streamMastraAgent`), like
 * `mastra-stream-first-output.integration.spec.ts`, substituting only the
 * language model. The local tool is registered under the CANONICAL id
 * `brainstrike.executeCommand` so the real pipeline resolves it through
 * `toolNameMap` against the native budget catalog and grants it the declared
 * 120s (+5s margin) execution budget end to end (Task 4). Wall-clock: real
 * timers, uncached integration lane.
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
// Canonical native id: registering the tool under this id is what exercises
// Task 4's `toolNameMap` lookup against the native budget catalog end to end.
const TOOL_ID = 'brainstrike.executeCommand';
// The dot is not provider-safe, so `sanitizeTools` rewrites it to an
// underscore before the tool reaches the model; the scripted model must name
// the SANITIZED id in its `tool-call`/`toolName` field, exactly as a real
// provider would echo back the tool name it was offered.
const SANITIZED_TOOL_NAME = 'brainstrike_executeCommand';
// Three times the 400ms inactivity window this file configures, so a
// watchdog that measured the tool phase against that window would trip well
// before the tool ever returns.
const SILENT_TOOL_SLEEP_MS = 1200;

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

/** A stream that emits one text delta and then never resolves or closes. */
function stalledAfterFirstDeltaStream(): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ id: 'f', type: 'text-start' });
      controller.enqueue({ delta: 'thinking', id: 'f', type: 'text-delta' });
      // Deliberately never enqueue text-end/finish, never close.
    },
  });
}

function promptHasToolResult(options: LanguageModelV2CallOptions): boolean {
  return Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
}

/** Step 1 calls the tool; step 2 answers `done`. */
function toolThenDoneModel(): LanguageModelV2 {
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) =>
      Promise.resolve({
        stream: promptHasToolResult(options)
          ? enqueue([
              { type: 'stream-start', warnings: [] },
              { id: 'f', type: 'text-start' },
              { delta: 'done', id: 'f', type: 'text-delta' },
              { id: 'f', type: 'text-end' },
              { finishReason: 'stop', type: 'finish', usage: USAGE },
            ])
          : enqueue([
              { type: 'stream-start', warnings: [] },
              {
                input: JSON.stringify({ command: 'sleep-silently' }),
                toolCallId: 'call-1',
                toolName: SANITIZED_TOOL_NAME,
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

/** A provider whose stream emits one delta then stalls, forever. */
function stalledProviderModel(): LanguageModelV2 {
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: () => Promise.resolve({ stream: stalledAfterFirstDeltaStream() }),
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

/** Sleeps silently for `SILENT_TOOL_SLEEP_MS` (no output), then resolves. */
function silentExecuteCommandTool() {
  return createTool({
    description: 'Fake execute-command tool that sleeps silently.',
    execute: () =>
      new Promise<{ ok: boolean }>((resolve) => {
        setTimeout(() => resolve({ ok: true }), SILENT_TOOL_SLEEP_MS);
      }),
    id: TOOL_ID,
    inputSchema: z.object({ command: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
  });
}

async function runTurn(model: LanguageModelV2): Promise<StreamChunk[]> {
  modelHolder.current = model;
  const iterator = await streamMastraAgent(
    [{ id: 'u1', parts: [{ text: 'run the silent tool', type: 'text' }], role: 'user' }],
    {
      runtime: { apiKey: 'test-key', provider: 'openai' },
      tools: { [TOOL_ID]: silentExecuteCommandTool() },
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

function findRunFailed(
  chunks: readonly StreamChunk[]
): Extract<StreamChunk, { type: 'run-event' }> | undefined {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
      chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
  );
}

const ENV_KEYS = ['BRAINSTRIKE_STREAM_INACTIVITY_MS', 'BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] as const;

describe('stream watchdog tool-executing phase (real Mastra loop)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
    // A tight inter-output window. Left at the default this test would take
    // no real position: only a window shorter than the tool's silent sleep
    // proves the tool-executing phase, not the streaming phase, is what
    // shields the call.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '400';
    // Stall recovery (default budget 2) would otherwise mask a missing
    // tool-executing phase: a "stall" during tool execution still carries the
    // by-then-completed tool result forward and the retry answers `done`
    // anyway, so the RED case (Task 8's wiring reverted) would falsely stay
    // green. Opting out makes a real stall terminal, which is what both cases
    // in this file need to prove.
    process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = '1';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('a silent tool outlives the inactivity window', async () => {
    const chunks = await runTurn(toolThenDoneModel());
    const kinds = runEventKinds(chunks);

    expect(kinds).toContain('run.finished');
    expect(kinds).not.toContain('run.failed');
    expect(textOf(chunks)).toContain('done');
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk)).not.toContain('stream_inactivity_timeout');
    }
  }, 30_000);

  it('a stalled provider still dies', async () => {
    // Stall recovery is disabled globally in beforeEach (see comment there),
    // so exactly one `run.failed` is observed here rather than a masked retry.
    const chunks = await runTurn(stalledProviderModel());
    const failure = findRunFailed(chunks);

    expect(failure).toBeDefined();
    expect(failure?.event.metadata).toEqual(
      expect.objectContaining({
        code: 'stream_inactivity_timeout',
        inactivityMs: 400,
        phase: 'streaming',
      })
    );
  }, 30_000);
});
