import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalLanguageModel, LocalLanguageModel } from '../local-language-model';
import type { LocalLlmGenerationResult } from '../types';

// Store mock generate function for test manipulation
const mockGenerateResult: LocalLlmGenerationResult = {
  text: 'Test response',
  finishReason: 'stop',
  usage: {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  },
};

const mockGenerate = vi.fn().mockImplementation(() => Promise.resolve(mockGenerateResult));
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockIsReady = vi.fn().mockReturnValue(false);
const mockDispose = vi.fn().mockResolvedValue(undefined);

// Mock LocalLlmBackend as a class to avoid actual model loading
vi.mock('../local-llm-backend', () => ({
  LocalLlmBackend: class MockLocalLlmBackend {
    initialize = mockInitialize;
    generate = mockGenerate;
    isReady = mockIsReady;
    dispose = mockDispose;
  },
}));

describe('LocalLanguageModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and properties', () => {
    it('sets correct specification version', () => {
      const model = new LocalLanguageModel('test-model');
      expect(model.specificationVersion).toBe('v2');
    });

    it('sets correct provider', () => {
      const model = new LocalLanguageModel('test-model');
      expect(model.provider).toBe('local');
    });

    it('sets modelId from constructor', () => {
      const model = new LocalLanguageModel('my-custom-model');
      expect(model.modelId).toBe('my-custom-model');
    });

    it('sets supportedUrls to empty object (no URL support)', () => {
      const model = new LocalLanguageModel('test-model');
      expect(model.supportedUrls).toEqual({});
    });
  });

  describe('createLocalLanguageModel factory', () => {
    it('creates a LocalLanguageModel instance', () => {
      const model = createLocalLanguageModel('test-model');
      expect(model).toBeInstanceOf(LocalLanguageModel);
    });

    it('passes modelId correctly', () => {
      const model = createLocalLanguageModel('factory-model');
      expect(model.modelId).toBe('factory-model');
    });

    it('accepts settings parameter', () => {
      const model = createLocalLanguageModel('test-model', {
        maxNewTokens: 100,
        temperature: 0.7,
      });
      expect(model).toBeInstanceOf(LocalLanguageModel);
    });
  });

  describe('doGenerate', () => {
    it('returns a PromiseLike result', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = model.doGenerate(options);
      expect(result).toHaveProperty('then');

      const resolved = await result;
      expect(resolved).toHaveProperty('finishReason');
      expect(resolved).toHaveProperty('usage');
    });

    it('handles system messages', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          { role: 'system' as const, content: 'You are helpful' },
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result.finishReason).toBe('stop');
    });

    it('handles assistant messages', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] },
          { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Hello!' }] },
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'How are you?' }] },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('usage');
    });

    it('includes hidden reasoning as a separate content part when present', async () => {
      mockGenerate.mockResolvedValueOnce({
        ...mockGenerateResult,
        reasoningText: 'Analyze the request first.',
      } satisfies LocalLlmGenerationResult);
      const model = new LocalLanguageModel('test-model');

      const result = await model.doGenerate({
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      });

      expect(result.content).toEqual([
        {
          type: 'reasoning',
          text: 'Analyze the request first.',
        },
        {
          type: 'text',
          text: 'Test response',
        },
      ]);
    });

    it('handles tool result messages', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'What time is it?' }] },
          {
            role: 'tool' as const,
            content: [
              {
                type: 'tool-result' as const,
                toolCallId: 'call-123',
                toolName: 'get_time',
                result: { time: '12:00' },
              },
            ],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result.finishReason).toBe('stop');
    });

    it('handles empty prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('respects maxOutputTokens from options', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
        maxOutputTokens: 100,
      };

      const result = await model.doGenerate(options);
      // V2 uses request.body instead of rawCall.rawSettings
      expect(result.request?.body).toHaveProperty('maxNewTokens', 100);
    });

    it('respects temperature from options', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
        temperature: 0.8,
      };

      const result = await model.doGenerate(options);
      // V2 uses request.body instead of rawCall.rawSettings
      expect(result.request?.body).toHaveProperty('temperature', 0.8);
    });

    it('handles tools array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'What time?' }] },
        ],
        tools: [
          {
            type: 'function' as const,
            name: 'get_time',
            description: 'Get current time',
            inputSchema: {
              type: 'object' as const,
              properties: {
                timezone: { type: 'string' },
              },
            },
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('filters non-function tools', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
        tools: [
          { type: 'other' as const } as unknown as { type: 'function'; name: string },
          {
            type: 'function' as const,
            name: 'test_tool',
            description: 'Test',
            inputSchema: { type: 'object' as const, properties: {} },
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('passes abortSignal to backend', async () => {
      const model = new LocalLanguageModel('test-model');
      const abortController = new AbortController();
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
        abortSignal: abortController.signal,
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });
  });

  describe('doStream', () => {
    it('returns a stream result', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doStream(options);
      expect(result).toHaveProperty('stream');
      // V2 uses request instead of rawCall
      expect(result).toHaveProperty('request');
    });

    it('stream contains text-delta part', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doStream(options);
      const reader = result.stream.getReader();
      const parts: unknown[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      const textDeltaPart = parts.find(
        (p: unknown) => (p as { type: string }).type === 'text-delta'
      );
      expect(textDeltaPart).toBeDefined();
    });

    it('stream contains finish part', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doStream(options);
      const reader = result.stream.getReader();
      const parts: unknown[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      const finishPart = parts.find((p: unknown) => (p as { type: string }).type === 'finish');
      expect(finishPart).toBeDefined();
      expect((finishPart as { finishReason: string }).finishReason).toBe('stop');
    });

    it('streams reasoning parts when reasoning content is present', async () => {
      mockGenerate.mockResolvedValueOnce({
        ...mockGenerateResult,
        reasoningText: 'Analyze first.',
      } satisfies LocalLlmGenerationResult);
      const model = new LocalLanguageModel('test-model');

      const result = await model.doStream({
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      });
      const reader = result.stream.getReader();
      const parts: unknown[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      expect(
        parts.find((part: unknown) => (part as { type?: string }).type === 'reasoning-start')
      ).toBeDefined();
      expect(
        parts.find((part: unknown) => (part as { type?: string }).type === 'reasoning-delta')
      ).toEqual(
        expect.objectContaining({
          delta: 'Analyze first.',
        })
      );
      expect(
        parts.find((part: unknown) => (part as { type?: string }).type === 'reasoning-end')
      ).toBeDefined();
    });

    it('preserves compact text part IDs while using secure randomness', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doStream(options);
      const reader = result.stream.getReader();
      const parts: unknown[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      const textStart = parts.find(
        (p: unknown) => (p as { type?: string }).type === 'text-start'
      ) as { id: string } | undefined;
      const textDelta = parts.find(
        (p: unknown) => (p as { type?: string }).type === 'text-delta'
      ) as { id: string } | undefined;
      const textEnd = parts.find((p: unknown) => (p as { type?: string }).type === 'text-end') as
        | { id: string }
        | undefined;

      expect(textStart?.id).toMatch(/^[a-f0-9]{9}$/);
      expect(textDelta?.id).toBe(textStart?.id);
      expect(textEnd?.id).toBe(textStart?.id);
    });
  });

  describe('message conversion edge cases', () => {
    it('handles null in prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          null as unknown as { role: 'user'; content: { type: 'text'; text: string }[] },
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles undefined in prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          undefined as unknown as { role: 'user'; content: { type: 'text'; text: string }[] },
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles primitive in prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          'string' as unknown as { role: 'user'; content: { type: 'text'; text: string }[] },
          123 as unknown as { role: 'user'; content: { type: 'text'; text: string }[] },
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles empty content array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [] }],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles non-array content', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'user' as const,
            content: 'string content' as unknown as { type: 'text'; text: string }[],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles multiple text parts', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: 'Part 1' },
              { type: 'text' as const, text: 'Part 2' },
            ],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('filters non-text parts', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'user' as const,
            content: [
              { type: 'image' as const, image: 'data:...' } as unknown as {
                type: 'text';
                text: string;
              },
              { type: 'text' as const, text: 'Describe this' },
            ],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool result with string result', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'tool' as const,
            content: [
              {
                type: 'tool-result' as const,
                toolCallId: 'call-1',
                toolName: 'test',
                result: 'string result',
              },
            ],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool result with object result', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'tool' as const,
            content: [
              {
                type: 'tool-result' as const,
                toolCallId: 'call-1',
                toolName: 'test',
                result: { data: 'value' },
              },
            ],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool content without tool-result type', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'tool' as const,
            content: [{ type: 'other', data: 'value' } as unknown as { type: 'tool-result' }],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool result without toolCallId', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'tool' as const,
            content: [
              {
                type: 'tool-result' as const,
                toolName: 'test',
                result: 'result',
              } as unknown as { type: 'tool-result'; toolCallId: string },
            ],
          },
        ],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });
  });

  describe('finish reason mapping', () => {
    it('maps length finish reason', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: 'Truncated',
        finishReason: 'length',
        usage: { promptTokens: 10, completionTokens: 100, totalTokens: 110 },
      });

      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doGenerate(options);
      expect(result.finishReason).toBe('length');
    });

    it('maps tool_calls finish reason', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'test', arguments: '{}' },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doGenerate(options);
      expect(result.finishReason).toBe('tool-calls');
      // V2 uses content array with tool-call items instead of toolCalls
      const toolCallContent = result.content.find(
        (item: { type: string }) => item.type === 'tool-call'
      );
      expect(toolCallContent).toBeDefined();
      expect((toolCallContent as { toolName: string }).toolName).toBe('test');
    });
  });

  describe('tool calls in stream', () => {
    it('streams tool calls', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'Weather in London?' }],
          },
        ],
      };

      const result = await model.doStream(options);
      const reader = result.stream.getReader();
      const parts: unknown[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      const toolCallPart = parts.find((p: unknown) => (p as { type: string }).type === 'tool-call');
      expect(toolCallPart).toBeDefined();
      expect((toolCallPart as { toolName: string }).toolName).toBe('get_weather');
    });
  });

  describe('settings from constructor', () => {
    it('uses settings maxNewTokens as default', async () => {
      let capturedOptions: unknown;
      mockGenerate.mockImplementationOnce((_: unknown, opts: unknown) => {
        capturedOptions = opts;
        return Promise.resolve({
          text: 'Response',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      });

      const model = new LocalLanguageModel('test-model', { maxNewTokens: 256 });
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      await model.doGenerate(options);
      expect((capturedOptions as { maxNewTokens: number }).maxNewTokens).toBe(256);
    });

    it('uses settings temperature as default', async () => {
      let capturedOptions: unknown;
      mockGenerate.mockImplementationOnce((_: unknown, opts: unknown) => {
        capturedOptions = opts;
        return Promise.resolve({
          text: 'Response',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      });

      const model = new LocalLanguageModel('test-model', { temperature: 0.5 });
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      await model.doGenerate(options);
      expect((capturedOptions as { temperature: number }).temperature).toBe(0.5);
    });

    it('options override settings', async () => {
      let capturedOptions: unknown;
      mockGenerate.mockImplementationOnce((_: unknown, opts: unknown) => {
        capturedOptions = opts;
        return Promise.resolve({
          text: 'Response',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      });

      const model = new LocalLanguageModel('test-model', {
        temperature: 0.5,
        topP: 0.8,
      });
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
        temperature: 0.9,
        topP: 0.95,
      };

      await model.doGenerate(options);
      const opts = capturedOptions as { temperature: number; topP: number };
      expect(opts.temperature).toBe(0.9);
      expect(opts.topP).toBe(0.95);
    });
  });

  describe('empty tools array', () => {
    it('handles empty tools array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
        tools: [],
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });
  });

  describe('no text in result', () => {
    it('handles result with no text', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      });

      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doGenerate(options);
      // V2 uses content array - no text content should be present when text is empty
      const textContent = result.content.find((item: { type: string }) => item.type === 'text');
      expect(textContent).toBeUndefined();
    });

    it('stream handles result with no text', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      });

      const model = new LocalLanguageModel('test-model');
      const options = {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }],
      };

      const result = await model.doStream(options);
      const reader = result.stream.getReader();
      const parts: unknown[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      // Should not have text-delta part when text is empty
      const textDeltaPart = parts.find(
        (p: unknown) => (p as { type: string }).type === 'text-delta'
      );
      expect(textDeltaPart).toBeUndefined();

      // Should still have finish part
      const finishPart = parts.find((p: unknown) => (p as { type: string }).type === 'finish');
      expect(finishPart).toBeDefined();
    });
  });
});
