/**
 * End-to-end coverage for REAL Mastra memory persistence through the live
 * stream-consumption path when desktop runtime storage is Turso-backed.
 *
 * This mirrors mastra-memory-persistence.spec.ts but swaps only the storage
 * implementation. The model is scripted; the Agent, tool loop, Memory, and
 * Turso stores are real.
 */

import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RuntimeAssistantMemorySettings } from '../memory-settings';
import type { TursoMastraMemoryOptions } from '../turso-mastra-memory';
import {
  createTursoTestClient,
  type TursoTestClient,
} from '../turso-mastra-memory/__tests__/turso-test-client';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

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
const { createTursoMastraMemory } = await import('../turso-mastra-memory');

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

function createFakeObservationModel(): LanguageModelV2 {
  const text = 'Observed: the user asked about Paris weather.';
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-om-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      usage: USAGE,
      warnings: [],
    }),
    doStream: async () => ({
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
    }),
  };
}

const OM_TINY_THRESHOLD_SETTINGS: RuntimeAssistantMemorySettings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    messageTokens: 10,
    observationTokens: 50,
  },
};

async function runTurnWithMemory(args: {
  runtime: TursoTestClient;
  memorySettings: RuntimeAssistantMemorySettings;
  threadId: string;
}): Promise<{ finalText: string }> {
  const memoryFactoryOptions: TursoMastraMemoryOptions = {
    database: args.runtime.client,
    memorySettings: args.memorySettings,
  };
  if (args.memorySettings.observationalMemory.enabled) {
    memoryFactoryOptions.observationalMemoryModel = createFakeObservationModel() as NonNullable<
      TursoMastraMemoryOptions['observationalMemoryModel']
    >;
  }
  const { memory } = await createTursoMastraMemory(memoryFactoryOptions);

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
    toolCallId: 'call-turso-memory-1',
    input: JSON.stringify({ city: 'Paris' }),
    finalText: 'It is 21C in Paris.',
  });

  const iterator = await streamMastraAgent(
    [{ id: 'u-turso-mem-1', role: 'user', parts: [{ type: 'text', text: 'weather in Paris?' }] }],
    {
      memory,
      runtime: {
        provider: 'openai',
        apiKey: 'test-key',
        memory: {
          threadId: args.threadId,
          resourceId: 'resource-turso-memory-test',
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
  return { finalText };
}

async function listThreadMessages(
  runtime: TursoTestClient,
  threadId: string
): Promise<PersistedMessageRow[]> {
  const result = await runtime.client.query<PersistedMessageRow>(
    'SELECT id, role, content FROM mastra_messages WHERE thread_id = ? ORDER BY "createdAt" ASC',
    [threadId]
  );
  return result.rows;
}

describe('Turso Mastra memory persistence through the live stream path', () => {
  let runtime: TursoTestClient;

  beforeEach(async () => {
    runtime = await createTursoTestClient('brainstrike-turso-live-memory-');
    modelHolder.current = undefined;
  });

  afterEach(async () => {
    await runtime.close();
  });

  it('persists final assistant text and tool invocations through real Turso memory storage', async () => {
    const threadId = 'thread-turso-persistence-test';
    const { finalText } = await runTurnWithMemory({
      memorySettings: OM_TINY_THRESHOLD_SETTINGS,
      runtime,
      threadId,
    });

    expect(finalText).toContain('21C in Paris');

    const rows = await listThreadMessages(runtime, threadId);
    const userRows = rows.filter((row) => row.role === 'user');
    const assistantRows = rows.filter((row) => row.role === 'assistant');
    expect(userRows.length).toBeGreaterThan(0);
    expect(assistantRows.length).toBeGreaterThan(0);

    const assistantParts = assistantRows.flatMap(parseParts);
    const persistedTexts = assistantParts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '');
    expect(persistedTexts.join('\n')).toContain('21C in Paris');

    const invocation = assistantParts.find(
      (part) => part.type === 'tool-invocation'
    )?.toolInvocation;
    expect(invocation).toMatchObject({
      toolCallId: 'call-turso-memory-1',
      toolName: 'get_weather',
      state: 'result',
    });
    expect(invocation?.result).toMatchObject({ city: 'Paris', temperatureC: 21 });
    expect(runtime.queries.join('\n')).not.toMatch(/\$1|::|JSONB|TIMESTAMPTZ/);
  }, 30_000);
});
