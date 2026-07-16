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
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'fake-model',
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
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');

      if (promptHasToolResult) {
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { id, type: 'text-start' },
            { delta: args.finalText, id, type: 'text-delta' },
            { id, type: 'text-end' },
            { finishReason: 'stop', type: 'finish', usage: USAGE },
          ]),
        });
      }

      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            input: args.input,
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            type: 'tool-call',
          },
          { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
        ]),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
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
    doGenerate: async () => {
      await wait();
      return {
        content: [{ text, type: 'text' as const }],
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
            controller.enqueue({ id: 'om', type: 'text-start' });
            controller.enqueue({ delta: text, id: 'om', type: 'text-delta' });
            controller.enqueue({ id: 'om', type: 'text-end' });
            controller.enqueue({ finishReason: 'stop', type: 'finish', usage: USAGE });
            controller.close();
          },
        }),
      };
    },
    modelId: 'fake-om-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

/**
 * Observer model that emits both an observation block AND a `<thread-title>`
 * inline extraction, mirroring the real Observer output when
 * `observation.threadTitle` is enabled. Used to prove the extracted title is
 * persisted to `mastra_threads.title` through the real PgliteMemoryStore.
 */
function createThreadTitleObservationModel(title: string): LanguageModelV2 {
  const text = `<observations>\n- 🟢 The user asked about Paris weather.\n</observations>\n<thread-title>${title}</thread-title>`;
  return {
    doGenerate: () =>
      Promise.resolve({
        content: [{ text, type: 'text' as const }],
        finishReason: 'stop' as const,
        usage: USAGE,
        warnings: [],
      }),
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ id: 'om', type: 'text-start' });
            controller.enqueue({ delta: text, id: 'om', type: 'text-delta' });
            controller.enqueue({ id: 'om', type: 'text-end' });
            controller.enqueue({ finishReason: 'stop', type: 'finish', usage: USAGE });
            controller.close();
          },
        }),
      }),
    modelId: 'fake-om-title-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
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
  assistantMessageId?: string;
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
  const { memory, storage } = await createPgliteMastraMemory(memoryFactoryOptions);

  const weatherTool = createTool({
    description: 'Get the current weather for a city.',
    execute: (inputData: { city: string }) =>
      Promise.resolve({ city: inputData.city, temperatureC: 21 }),
    id: 'get_weather',
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({ city: z.string(), temperatureC: z.number() }),
  });

  modelHolder.current = createScriptedToolCallModel({
    finalText: 'It is 21C in Paris.',
    input: JSON.stringify({ city: 'Paris' }),
    toolCallId: 'call-memory-1',
    toolName: 'get_weather',
  });

  const iterator = await streamMastraAgent(
    [{ id: 'u-mem-1', parts: [{ text: 'weather in Paris?', type: 'text' }], role: 'user' }],
    {
      memory,
      runtime: {
        apiKey: 'test-key',
        ...(args.assistantMessageId ? { assistantMessageId: args.assistantMessageId } : {}),
        provider: 'openai',
        ...(args.signal ? { signal: args.signal } : {}),
        memory: {
          memorySettings: args.memorySettings,
          resourceId: 'resource-memory-test',
          threadId: args.threadId,
        },
      },
      storage,
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

async function readThreadTitle(database: PGlite, threadId: string): Promise<string | null> {
  const result = await database.query<{ title: string }>(
    'SELECT title FROM mastra_threads WHERE id = $1',
    [threadId]
  );
  return result.rows[0]?.title ?? null;
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
    ['observational memory enabled', DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS],
    ['observational memory disabled', OM_DISABLED_SETTINGS],
    ['observational memory sealing snapshots', OM_TINY_THRESHOLD_SETTINGS],
  ] as const)('persists the assistant-ui message id with %s', async (_label, memorySettings) => {
    const threadId = 'thread-assistant-message-id';
    await runTurnWithMemory({
      assistantMessageId: 'assistant-client-id',
      database,
      memorySettings,
      threadId,
    });

    const rows = await listThreadMessages(database, threadId);
    const userRows = rows.filter((row) => row.role === 'user');
    const assistantRows = rows.filter((row) => row.role === 'assistant');
    expect(userRows.map((row) => row.id)).toContain('u-mem-1');
    expect(assistantRows.length).toBeGreaterThan(0);
    expect(assistantRows.map((row) => row.id)).toContain('assistant-client-id');
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
        state: 'result',
        toolCallId: 'call-memory-1',
        toolName: 'get_weather',
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
      generate: (request) => {
        hostRequests.push(request);
        return Promise.resolve({
          finishReason: 'stop' as const,
          text: 'Observed: the user asked about Paris weather.',
          usage: { completionTokens: 5, promptTokens: 5, totalTokens: 10 },
        });
      },
      warmup: () => Promise.resolve(),
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

  it('persists the observer-extracted thread title to mastra_threads.title', async () => {
    // With `observation.threadTitle` wired on, the real Observer's
    // `<thread-title>` output must land in the thread row through the real
    // PgliteMemoryStore.updateThread path — the auto-naming contract.
    const threadId = 'thread-om-title';
    const extractedTitle = 'Paris Weather Chat';
    const { finalText } = await runTurnWithMemory({
      database,
      memorySettings: OM_TINY_THRESHOLD_SETTINGS,
      observationalMemoryModel: createThreadTitleObservationModel(extractedTitle),
      threadId,
    });

    expect(finalText).toContain('21C in Paris');

    // OM observation can fire from background buffering shortly after the turn.
    await vi.waitFor(
      async () => {
        expect(await readThreadTitle(database, threadId)).toBe(extractedTitle);
      },
      { timeout: 10_000 }
    );
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
      onStreamConsumed: () => abortController.abort(),
      signal: abortController.signal,
      threadId,
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
