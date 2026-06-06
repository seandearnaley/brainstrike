/**
 * End-to-end coverage for the REAL Mastra agent tool-execution loop.
 *
 * Every other agent test mocks `@mastra/core/agent` and injects pre-baked stream
 * parts, so none of them exercise the real Mastra loop that actually invokes a
 * tool's `execute`. That blind spot let a resilience change silently break
 * hosted-provider tool calling while the whole suite stayed green (see the
 * "ASSISTANT RESILIENCE" note in AGENTS.md).
 *
 * This file deliberately does NOT mock `@mastra/core/agent`. It drives the real
 * `streamMastraAgent` → `collectCombinedTools` → real `Agent` → real tool
 * `execute` path, substituting only the language model with a scripted fake
 * (so no network/provider key is needed). The fake emits a tool call on the
 * first turn and a final answer on the second, mirroring the stream-part shape
 * produced by the in-repo `LocalLanguageModel`.
 */
import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StreamChunk } from '../types';

// vi.mock factories are hoisted above imports, so the model the fake provider
// returns must live in a hoisted holder the factory can close over.
const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

// Replace ONLY model construction. Everything else in agent-runtime
// (runtime resolution, sanitizeTools, collectCombinedTools, the real Agent, the
// real tool loop, and stream processing) runs unmocked.
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

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

/**
 * A scripted LanguageModelV2: first turn emits a single tool call; once the
 * prompt contains the tool result (role "tool"), it emits a final text answer.
 * This is the minimal real-model contract the Mastra loop drives.
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

describe('mastra real tool execution (real @mastra/core/agent)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it("invokes a tool's execute through the real agent loop and surfaces its result", async () => {
    const executeSpy = vi.fn((inputData: { city: string }) =>
      Promise.resolve({ city: inputData.city, temperatureC: 21 })
    );
    const weatherTool = createTool({
      id: 'get_weather',
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ city: z.string(), temperatureC: z.number() }),
      execute: executeSpy,
    });

    modelHolder.current = createScriptedToolCallModel({
      toolName: 'get_weather',
      toolCallId: 'call-1',
      input: JSON.stringify({ city: 'Paris' }),
      finalText: 'It is 21C in Paris.',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'weather in Paris?' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key' },
        tools: { get_weather: weatherTool },
      }
    );

    const runEventKinds: string[] = [];
    let finalText = '';
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      } else if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      }
    }

    // The assertion that would have caught the resilience regression: the real
    // Mastra loop actually called the tool's execute with the parsed input
    // (Mastra passes the validated input data as the first argument).
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({ city: 'Paris' });

    // And the tool result flowed back through to a terminal run-event + answer.
    expect(runEventKinds).toContain('tool.completed');
    expect(finalText).toContain('21C in Paris');
  });

  it('does not invoke execute when the model never calls the tool', async () => {
    const executeSpy = vi.fn(() => Promise.resolve({ ok: true }));
    const noopTool = createTool({
      id: 'get_weather',
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: executeSpy,
    });

    // A model that answers directly without a tool call.
    modelHolder.current = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 't' });
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'No tools needed.' });
              controller.enqueue({ type: 'text-end', id: 't' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
              controller.close();
            },
          }),
        }),
    };

    const iterator = await streamMastraAgent(
      [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key' },
        tools: { get_weather: noopTool },
      }
    );

    let finalText = '';
    for await (const chunk of iterator) {
      if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      }
    }

    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalText).toContain('No tools needed.');
  });

  it('terminates gracefully when the model stream emits a provider error part', async () => {
    // Reproduces the live Anthropic 404 path: the provider error arrives as a
    // model `error` stream part. The run must NOT hang — it terminates with a
    // visible message, a `run.failed` run-event (clears in-flight spinners), and
    // an error finish, all through the real Mastra agent loop.
    modelHolder.current = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'error',
                error: { message: 'Not Found', name: 'AI_APICallError' },
              });
              controller.close();
            },
          }),
        }),
    };

    const iterator = await streamMastraAgent(
      [{ id: 'u3', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      { runtime: { provider: 'openai', apiKey: 'test-key' } }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const text = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta'
      )
      .map((chunk) => chunk.value)
      .join('');
    expect(text).toContain('Not Found');

    const runEventKinds = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(runEventKinds).toContain('run.failed');

    const finish = chunks.find((chunk) => chunk.type === 'message-finish');
    expect(finish).toMatchObject({ finishReason: 'error' });
  });
});
