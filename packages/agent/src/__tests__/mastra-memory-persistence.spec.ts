/**
 * End-to-end coverage for REAL Mastra memory persistence through the live
 * stream-consumption path.
 *
 * This pins two contracts that thread-reload hydration depends on:
 *
 * 1. After a turn is consumed via `streamMastraAgent` (including when the
 *    request abort signal fires immediately after consumption, which is how
 *    the desktop HTTP handler behaves on normal request close), the final
 *    assistant `text` part MUST be present in `mastra_messages`. The stream
 *    consumer returns at the `finish` chunk — that early return must never
 *    cut off Mastra's end-of-run message finalization.
 *
 * 2. The PERSISTED DIALECT: Mastra v2 stores tool calls as
 *    `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName,
 *    args, state, result } }` parts (results inline — there are no
 *    `role: 'tool'` rows), alongside `reasoning`, `step-start`, and
 *    `data-om-*` parts. History hydration in @brainstrike/app-shell must
 *    understand this shape; fixtures there mirror these assertions.
 *
 * Like mastra-tool-execution.spec.ts, this file does NOT mock
 * `@mastra/core/agent`. It drives the real agent loop with a real
 * PGlite-backed Mastra Memory (the same store the desktop app uses) and a
 * scripted fake language model, then asserts on the rows Mastra actually
 * persisted. Observational-memory variants run with a fake observation model
 * so OM activation/sealing (which splits the assistant message into multiple
 * snapshot rows) is exercised too.
 */

import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RuntimeAssistantMemorySettings } from '../memory-settings';
import type { PgliteDatabase, PgliteMastraMemoryOptions } from '../pglite-mastra-memory';
import { LlmHostChatModel } from '../providers/local/llm-host-chat-model';
import type {
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
} from '../providers/local/llm-host-client';

// vi.mock factories are hoisted above imports, so the model the fake provider
// returns must live in a hoisted holder the factory can close over.
const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

// Replace ONLY model construction. Everything else (runtime resolution, the
// real Agent, the real tool loop, the real Memory + PgliteMemoryStore, and
// stream processing) runs unmocked.
vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    getDefaultModel: () => 'fake-model',
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
  };
});

const { streamMastraAgent } = await import('../mastra/agent-runtime');
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

interface PersistedPart {
  readonly text?: string;
  readonly toolInvocation?: {
    readonly result?: unknown;
    readonly state?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
  };
  readonly type?: string;
}

interface PersistedMessageRow {
  readonly content: string | { parts?: PersistedPart[] };
  readonly id: string;
  readonly role: string;
}

function parseParts(row: PersistedMessageRow): PersistedPart[] {
  const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
  return Array.isArray(content?.parts) ? (content.parts as PersistedPart[]) : [];
}

/**
 * Scripted LanguageModelV2: first turn emits a tool call; once the prompt
 * contains the tool result, it emits the final visible answer.
 */
function createScriptedToolCallModel(args: {
  toolName: string;
  toolCallId: string;
  input: string;
  finalText: string;
}): LanguageModelV2 {
  const enqueue = (parts: LanguageModelV2StreamPart[]) =>
    new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });

  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');

      if (promptHasToolResult) {
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id },
            { type: 'text-delta', id, delta: args.finalText },
            { type: 'text-end', id },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ]),
        });
      }

      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            input: args.input,
          },
          { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
        ]),
      });
    },
  };
}

/**
 * A trivially compliant model for observational-memory observation calls:
 * always answers with a short observation, both streaming and non-streaming.
 */
function createFakeObservationModel(delayMs = 0): LanguageModelV2 {
  const text = 'Observed: the user asked about Paris weather.';
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-om-model',
    supportedUrls: {},
    doGenerate: async () => {
      await wait();
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: 'stop' as const,
        usage: USAGE,
        warnings: [],
      };
    },
    doStream: async () => {
      await wait();
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'om' });
            controller.enqueue({ type: 'text-delta', id: 'om', delta: text });
            controller.enqueue({ type: 'text-end', id: 'om' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            controller.close();
          },
        }),
      };
    },
  };
}

const OM_DISABLED_SETTINGS: RuntimeAssistantMemorySettings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};

// Thresholds low enough that observational memory ACTIVATES during a tiny
// test turn (mirrors long-running production threads where OM owns message
// sealing mid-run).
const OM_TINY_THRESHOLD_SETTINGS: RuntimeAssistantMemorySettings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    messageTokens: 10,
    observationTokens: 50,
  },
};

async function runTurnWithMemory(args: {
  database: PGlite;
  memorySettings: RuntimeAssistantMemorySettings;
  threadId: string;
  signal?: AbortSignal;
  observationDelayMs?: number;
  observationalMemoryModel?: LanguageModelV2;
  onStreamConsumed?: () => void;
}): Promise<{ finalText: string }> {
  const memoryFactoryOptions: PgliteMastraMemoryOptions = {
    database: args.database as unknown as PgliteDatabase,
    memorySettings: args.memorySettings,
  };
  if (args.memorySettings.observationalMemory.enabled) {
    memoryFactoryOptions.observationalMemoryModel = (args.observationalMemoryModel ??
      createFakeObservationModel(args.observationDelayMs ?? 0)) as NonNullable<
      PgliteMastraMemoryOptions['observationalMemoryModel']
    >;
  }
  const { memory } = await createPgliteMastraMemory(memoryFactoryOptions);

  const weatherTool = createTool({
    id: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({ city: z.string(), temperatureC: z.number() }),
    execute: (inputData: { city: string }) =>
      Promise.resolve({ city: inputData.city, temperatureC: 21 }),
  });

  modelHolder.current = createScriptedToolCallModel({
    toolName: 'get_weather',
    toolCallId: 'call-memory-1',
    input: JSON.stringify({ city: 'Paris' }),
    finalText: 'It is 21C in Paris.',
  });

  const iterator = await streamMastraAgent(
    [{ id: 'u-mem-1', role: 'user', parts: [{ type: 'text', text: 'weather in Paris?' }] }],
    {
      memory,
      runtime: {
        provider: 'openai',
        apiKey: 'test-key',
        ...(args.signal ? { signal: args.signal } : {}),
        memory: {
          threadId: args.threadId,
          resourceId: 'resource-memory-test',
          memorySettings: args.memorySettings,
        },
      },
      tools: { get_weather: weatherTool },
    }
  );

  let finalText = '';
  for await (const chunk of iterator) {
    if (chunk.type === 'text-delta') {
      finalText += chunk.value;
    }
  }
  args.onStreamConsumed?.();
  return { finalText };
}

async function listThreadMessages(
  database: PGlite,
  threadId: string
): Promise<PersistedMessageRow[]> {
  const result = await database.query(
    'SELECT id, role, content FROM mastra_messages WHERE thread_id = $1 ORDER BY "createdAt" ASC',
    [threadId]
  );
  return result.rows as PersistedMessageRow[];
}

describe('mastra memory persistence through the live stream path', () => {
  let database: PGlite;

  beforeEach(() => {
    database = new PGlite();
    modelHolder.current = undefined;
  });

  afterEach(async () => {
    await database.close();
  });

  it.each([
    ['observational memory enabled (desktop default)', DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS],
    ['observational memory disabled', OM_DISABLED_SETTINGS],
    ['observational memory activated mid-run (tiny thresholds)', OM_TINY_THRESHOLD_SETTINGS],
  ] as const)(
    'persists the final assistant text and tool invocations — %s',
    async (_label, memorySettings) => {
      const threadId = 'thread-persistence-test';
      const { finalText } = await runTurnWithMemory({ database, memorySettings, threadId });

      // The stream itself delivered the answer to the UI...
      expect(finalText).toContain('21C in Paris');

      const rows = await listThreadMessages(database, threadId);
      const userRows = rows.filter((row) => row.role === 'user');
      const assistantRows = rows.filter((row) => row.role === 'assistant');
      expect(userRows.length).toBeGreaterThan(0);
      expect(assistantRows.length).toBeGreaterThan(0);

      const assistantParts = assistantRows.flatMap(parseParts);

      // ...and the durable record must contain the SAME answer. This is the
      // regression assertion: cancelling the Mastra stream at the finish chunk
      // aborts output-result persistence, leaving threads with tool calls but
      // no visible assistant text after an app reload.
      const persistedTexts = assistantParts
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '');
      expect(persistedTexts.join('\n')).toContain('21C in Paris');

      // Document the REAL persisted tool dialect (Mastra v2 `tool-invocation`
      // with the nested invocation carrying the inline result) — the history
      // hydrator must understand this shape, not the legacy `tool-call` one.
      const invocation = assistantParts.find(
        (part) => part.type === 'tool-invocation'
      )?.toolInvocation;
      expect(invocation).toMatchObject({
        toolCallId: 'call-memory-1',
        toolName: 'get_weather',
        state: 'result',
      });
      expect(invocation?.result).toMatchObject({ city: 'Paris', temperatureC: 21 });
    },
    30_000
  );

  it('drives observational memory through the REAL llm-host proxy model (local memory model)', async () => {
    // Mirrors the desktop "memory model = built-in local" configuration: the
    // observational-memory Observer runs on LlmHostChatModel, whose generations
    // are proxied to a host client (the seam desktop main implements over the
    // hidden llm-host). Proves OM works against the proxy with plain text
    // prompting — no JSON mode, no API key.
    const hostRequests: LocalLlmHostGenerateRequest[] = [];
    const hostClient: LocalLlmHostClient = {
      warmup: () => Promise.resolve(),
      generate: (request) => {
        hostRequests.push(request);
        return Promise.resolve({
          text: 'Observed: the user asked about Paris weather.',
          finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        });
      },
    };

    const threadId = 'thread-local-om-proxy';
    const { finalText } = await runTurnWithMemory({
      database,
      memorySettings: OM_TINY_THRESHOLD_SETTINGS,
      observationalMemoryModel: new LlmHostChatModel(
        'onnx-community/gemma-4-E2B-it-ONNX',
        hostClient
      ),
      threadId,
    });

    expect(finalText).toContain('21C in Paris');

    // OM observation generation ran through the host client (it may fire from
    // background buffering shortly after the turn completes).
    await vi.waitFor(
      () => {
        expect(hostRequests.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 }
    );
    expect(hostRequests[0]?.modelId).toBe('onnx-community/gemma-4-E2B-it-ONNX');

    const rows = await listThreadMessages(database, threadId);
    const assistantParts = rows.filter((row) => row.role === 'assistant').flatMap(parseParts);
    const persistedTexts = assistantParts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '');
    expect(persistedTexts.join('\n')).toContain('21C in Paris');
  }, 30_000);

  it('persists the final assistant text even when the request signal aborts right after the stream is consumed (desktop request-close behavior)', async () => {
    // The desktop assistant server wires `req.on('close', ...)` to an
    // AbortController, and that close event can fire on NORMAL completion as
    // soon as the HTTP exchange ends — i.e. immediately after the last
    // stream chunk is delivered. The final assistant message save (the only
    // one carrying the visible `text` part) must already be durable by then,
    // even when background observational-memory work is slow and competing
    // for the per-thread save queue.
    const threadId = 'thread-abort-after-finish';
    const abortController = new AbortController();
    const { finalText } = await runTurnWithMemory({
      database,
      // Tiny thresholds + a slow observation model: observational memory
      // activates mid-run and its background buffering keeps the per-thread
      // save queue busy, so the final tail save is still pending when the
      // request-close abort fires — the exact production race.
      memorySettings: OM_TINY_THRESHOLD_SETTINGS,
      observationDelayMs: 400,
      threadId,
      signal: abortController.signal,
      onStreamConsumed: () => abortController.abort(),
    });

    expect(finalText).toContain('21C in Paris');

    // Give any raced async persistence a moment to settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const rows = await listThreadMessages(database, threadId);
    const assistantParts = rows.filter((row) => row.role === 'assistant').flatMap(parseParts);
    const persistedTexts = assistantParts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '');
    expect(persistedTexts.join('\n')).toContain('21C in Paris');
  }, 30_000);
});
