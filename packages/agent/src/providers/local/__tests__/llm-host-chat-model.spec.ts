import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { LlmHostChatModel } from '../llm-host-chat-model';
import type {
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
  LocalLlmHostRequestOptions,
} from '../llm-host-client';
import type { LocalLlmGenerationResult } from '../types';

const USER_PROMPT = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] },
];

function makeResult(overrides: Partial<LocalLlmGenerationResult> = {}): LocalLlmGenerationResult {
  return {
    text: 'final answer',
    finishReason: 'stop',
    usage: { promptTokens: 12, completionTokens: 6, totalTokens: 18 },
    ...overrides,
  };
}

interface ScriptedClient extends LocalLlmHostClient {
  requests: LocalLlmHostGenerateRequest[];
}

function makeClient(
  script: (
    request: LocalLlmHostGenerateRequest,
    options: LocalLlmHostRequestOptions
  ) => Promise<LocalLlmGenerationResult>
): ScriptedClient {
  const requests: LocalLlmHostGenerateRequest[] = [];
  return {
    requests,
    generate: (request, options = {}) => {
      requests.push(request);
      return script(request, options);
    },
    warmup: vi.fn().mockResolvedValue(undefined),
  };
}

async function collectStream(
  model: LlmHostChatModel,
  options: Parameters<LlmHostChatModel['doStream']>[0]
): Promise<LanguageModelV2StreamPart[]> {
  const { stream } = await model.doStream(options);
  const reader = stream.getReader();
  const parts: LanguageModelV2StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
  }
  return parts;
}

describe('LlmHostChatModel', () => {
  it('converts cumulative text snapshots into incremental text deltas', async () => {
    const client = makeClient(async (_request, options) => {
      options.onProgress?.({ kind: 'text', text: 'final' });
      options.onProgress?.({ kind: 'text', text: 'final answ' });
      return makeResult({ text: 'final answer' });
    });
    const model = new LlmHostChatModel('test-model', client);

    const parts = await collectStream(model, { prompt: USER_PROMPT });

    const deltas = parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => (part as { delta: string }).delta);
    expect(deltas).toEqual(['final', ' answ', 'er']);
    expect(parts.map((part) => part.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
  });

  it('streams reasoning snapshots before text and closes reasoning when text starts', async () => {
    const client = makeClient(async (_request, options) => {
      options.onProgress?.({ kind: 'reasoning', reasoningText: 'thinking' });
      options.onProgress?.({ kind: 'reasoning', reasoningText: 'thinking hard' });
      options.onProgress?.({ kind: 'text', text: 'answer' });
      return makeResult({ text: 'answer', reasoningText: 'thinking hard' });
    });
    const model = new LlmHostChatModel('test-model', client);

    const parts = await collectStream(model, { prompt: USER_PROMPT });

    expect(parts.map((part) => part.type)).toEqual([
      'stream-start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
  });

  it('emits the full final text when no snapshots arrived', async () => {
    const client = makeClient(async () => makeResult({ text: 'all at once' }));
    const model = new LlmHostChatModel('test-model', client);

    const parts = await collectStream(model, { prompt: USER_PROMPT });

    const deltas = parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => (part as { delta: string }).delta);
    expect(deltas).toEqual(['all at once']);
    const finish = parts.find((part) => part.type === 'finish') as {
      finishReason: string;
      usage: { inputTokens?: number; outputTokens?: number };
    };
    expect(finish.finishReason).toBe('stop');
    expect(finish.usage).toEqual({ inputTokens: 12, outputTokens: 6, totalTokens: 18 });
  });

  it('emits tool-call parts and a tool-calls finish reason', async () => {
    const client = makeClient(async () =>
      makeResult({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      })
    );
    const model = new LlmHostChatModel('test-model', client);

    const parts = await collectStream(model, { prompt: USER_PROMPT });

    const toolCall = parts.find((part) => part.type === 'tool-call') as {
      input: string;
      toolCallId: string;
      toolName: string;
    };
    expect(toolCall).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'get_weather',
      input: '{"city":"Paris"}',
    });
    const finish = parts.find((part) => part.type === 'finish') as { finishReason: string };
    expect(finish.finishReason).toBe('tool-calls');
  });

  it('keeps emitted text and ignores a diverging snapshot', async () => {
    const client = makeClient(async (_request, options) => {
      options.onProgress?.({ kind: 'text', text: 'hello wor' });
      options.onProgress?.({ kind: 'text', text: 'REWRITTEN everything' });
      return makeResult({ text: 'hello world' });
    });
    const model = new LlmHostChatModel('test-model', client);

    const parts = await collectStream(model, { prompt: USER_PROMPT });

    const deltas = parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => (part as { delta: string }).delta);
    expect(deltas).toEqual(['hello wor', 'ld']);
  });

  it('errors the stream when the host client rejects', async () => {
    const client = makeClient(async () => {
      throw new Error('host exploded');
    });
    const model = new LlmHostChatModel('test-model', client);

    const { stream } = await model.doStream({ prompt: USER_PROMPT });
    const reader = stream.getReader();

    await expect(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          break;
        }
      }
    }).rejects.toThrow('host exploded');
  });

  it('passes the abort signal, tools, thinking and sampling options to the client', async () => {
    let observedOptions: LocalLlmHostRequestOptions | undefined;
    const client: ScriptedClient = {
      requests: [],
      generate: (request, options = {}) => {
        client.requests.push(request);
        observedOptions = options;
        return Promise.resolve(makeResult());
      },
      warmup: vi.fn().mockResolvedValue(undefined),
    };
    const abortController = new AbortController();
    const model = new LlmHostChatModel('test-model', client, {
      thinking: { enabled: false },
      temperature: 0.4,
    });

    await model.doGenerate({
      prompt: USER_PROMPT,
      abortSignal: abortController.signal,
      maxOutputTokens: 99,
      tools: [
        {
          type: 'function',
          name: 'get_time',
          description: 'Get time',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(observedOptions?.signal).toBe(abortController.signal);
    const request = client.requests[0];
    expect(request?.modelId).toBe('test-model');
    expect(request?.options).toMatchObject({
      maxNewTokens: 99,
      temperature: 0.4,
      thinking: { enabled: false },
    });
    expect(request?.options?.tools?.[0]?.function.name).toBe('get_time');
  });

  it('doGenerate maps reasoning, text and tool calls into V2 content', async () => {
    const client = makeClient(async () =>
      makeResult({
        text: 'visible',
        reasoningText: 'hidden thoughts',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
      })
    );
    const model = new LlmHostChatModel('test-model', client);

    const result = await model.doGenerate({ prompt: USER_PROMPT });

    expect(result.content).toEqual([
      { type: 'reasoning', text: 'hidden thoughts' },
      { type: 'text', text: 'visible' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: '{}' },
    ]);
  });
});
