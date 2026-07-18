/**
 * End-to-end coverage for the REAL Mastra agent loop driving the built-in
 * LOCAL provider through the llm-host proxy model.
 *
 * Unlike mastra-tool-execution.spec.ts (which swaps the model via a mocked
 * provider-factory), this file mocks NOTHING in packages/agent: it sends
 * provider 'local' with an injected `RuntimeData.localLlmHostClient`, so the
 * real `createProvider` resolves the real `LlmHostChatModel`, the real
 * message/tool conversion runs against Mastra's actual V2 prompt dialect
 * (tool-result `output` envelopes, assistant tool-call parts), and the real
 * Agent executes the tool. Only the host boundary (`LocalLlmHostClient`) is a
 * scripted fake — exactly the seam the desktop main process implements over
 * IPC.
 *
 * This is the LIVE validation required by docs/agents/local-inference.md for the local→Mastra
 * path: if the proxy model, the conversion layer, or the provider seam breaks
 * tool calling, this fails while mocked suites stay green.
 */
import { createTool } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { streamMastraAgent } from '../mastra/agent-runtime';
import type {
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
  LocalLlmHostRequestOptions,
} from '../providers/local/llm-host-client';
import type { LocalLlmGenerationResult } from '../providers/local/types';
import type { StreamChunk } from '../types';

const USAGE = { completionTokens: 4, promptTokens: 8, totalTokens: 12 } as const;

/**
 * Scripted host client: first generation returns a tool call; once the prompt
 * carries the tool response, it streams text snapshots and returns the final
 * answer. Mirrors the desktop llm-host contract (cumulative snapshots + one
 * final result).
 */
function createScriptedHostClient(): LocalLlmHostClient & {
  requests: LocalLlmHostGenerateRequest[];
} {
  const requests: LocalLlmHostGenerateRequest[] = [];
  return {
    generate: (
      request: LocalLlmHostGenerateRequest,
      options: LocalLlmHostRequestOptions = {}
    ): Promise<LocalLlmGenerationResult> => {
      requests.push(request);
      const hasToolResponse = request.messages.some(
        (message) => message.role === 'tool' && message.toolResponses !== undefined
      );

      if (hasToolResponse) {
        options.onProgress?.({ kind: 'text', text: 'It is ' });
        options.onProgress?.({ kind: 'text', text: 'It is 21C in' });
        return Promise.resolve({
          finishReason: 'stop',
          text: 'It is 21C in Paris.',
          usage: USAGE,
        });
      }

      return Promise.resolve({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          {
            function: { arguments: '{"city":"Paris"}', name: 'get_weather' },
            id: 'call-local-1',
            type: 'function',
          },
        ],
        usage: USAGE,
      });
    },
    requests,
    warmup: vi.fn().mockResolvedValue(undefined),
  };
}

describe('mastra local provider via llm-host proxy (real agent loop, real provider factory)', () => {
  it('executes tools and streams the final answer through the injected host client', async () => {
    const executeSpy = vi.fn((inputData: { city: string }) =>
      Promise.resolve({ city: inputData.city, temperatureC: 21 })
    );
    const weatherTool = createTool({
      description: 'Get the current weather for a city.',
      execute: executeSpy,
      id: 'get_weather',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ city: z.string(), temperatureC: z.number() }),
    });

    const hostClient = createScriptedHostClient();

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'weather in Paris?', type: 'text' }], role: 'user' }],
      {
        runtime: {
          localLlmHostClient: hostClient,
          model: 'onnx-community/gemma-4-E2B-it-ONNX',
          provider: 'local',
          providerOptions: { local: { thinking: { enabled: false } } },
        },
        tools: { get_weather: weatherTool },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // The real Mastra loop executed the tool with parsed input.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({ city: 'Paris' });

    const runEventKinds = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(runEventKinds).toContain('tool.completed');

    const finalText = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta'
      )
      .map((chunk) => chunk.value)
      .join('');
    expect(finalText).toContain('21C in Paris');

    // Snapshot→delta streaming produced multiple incremental deltas, not one blob.
    const textDeltaCount = chunks.filter((chunk) => chunk.type === 'text-delta').length;
    expect(textDeltaCount).toBeGreaterThan(1);

    // The host client saw both generations...
    expect(hostClient.requests).toHaveLength(2);
    // ...with the COMPACT local instruction set (not the hosted multi-thousand
    // token playbook, which overwhelms the 2B model and bloats the WebGPU
    // prefill)...
    const systemMessage = hostClient.requests[0]?.messages.find(
      (message) => message.role === 'system'
    );
    expect(systemMessage?.content).toContain('running fully on this device');
    expect(systemMessage?.content).not.toContain('Context Explorer alongside this chat');
    // ...with thinking options threaded through from providerOptions.local...
    expect(hostClient.requests[0]?.options?.thinking).toEqual({ enabled: false });
    expect(hostClient.requests[0]?.options?.tools?.[0]?.function.name).toBe('get_weather');

    // ...and the second prompt carried the full tool round in the local
    // dialect: the assistant message preserves its tool call, and the tool
    // message carries the model-facing JSON text projection from Mastra's V2
    // `output` envelope (not undefined, not a legacy `result` field).
    const secondRequest = hostClient.requests[1];
    const assistantWithToolCall = secondRequest?.messages.find(
      (message) => message.role === 'assistant' && message.toolCalls !== undefined
    );
    expect(assistantWithToolCall?.toolCalls?.[0]).toMatchObject({
      function: { name: 'get_weather' },
      id: 'call-local-1',
    });
    const toolMessage = secondRequest?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.toolResponses?.[0]?.name).toBe('get_weather');
    const projectedResponse = toolMessage?.toolResponses?.[0]?.response;
    expect(typeof projectedResponse).toBe('string');
    expect(JSON.parse(String(projectedResponse))).toMatchObject({
      city: 'Paris',
      temperatureC: 21,
    });
  });

  it('does not require an API key for the local provider', async () => {
    const hostClient = createScriptedHostClient();

    const iterator = await streamMastraAgent(
      [{ id: 'u2', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
      {
        runtime: {
          localLlmHostClient: hostClient,
          model: 'onnx-community/gemma-4-E2B-it-ONNX',
          provider: 'local',
        },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // Without tools the scripted client returns the tool_calls result, but the
    // loop has no matching tool — what matters here is the run terminates and
    // the provider resolved without an apiKey.
    expect(hostClient.requests.length).toBeGreaterThan(0);
  });
});
