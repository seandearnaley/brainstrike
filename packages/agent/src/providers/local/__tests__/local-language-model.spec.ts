import type { LanguageModelV1CallOptions } from '@ai-sdk/provider';
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
      expect(model.specificationVersion).toBe('v1');
    });

    it('sets correct provider', () => {
      const model = new LocalLanguageModel('test-model');
      expect(model.provider).toBe('local');
    });

    it('sets modelId from constructor', () => {
      const model = new LocalLanguageModel('my-custom-model');
      expect(model.modelId).toBe('my-custom-model');
    });

    it('sets supportsImageUrls to false', () => {
      const model = new LocalLanguageModel('test-model');
      expect(model.supportsImageUrls).toBe(false);
    });

    it('sets supportsStructuredOutputs to false', () => {
      const model = new LocalLanguageModel('test-model');
      expect(model.supportsStructuredOutputs).toBe(false);
    });

    it('sets defaultObjectGenerationMode to undefined', () => {
      const model = new LocalLanguageModel('test-model');
      expect(model.defaultObjectGenerationMode).toBeUndefined();
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = model.doGenerate(options);
      expect(result).toHaveProperty('then');

      const resolved = await result;
      expect(resolved).toHaveProperty('finishReason');
      expect(resolved).toHaveProperty('usage');
    });

    it('handles system messages', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result.finishReason).toBe('stop');
    });

    it('handles assistant messages', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
          { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('usage');
    });

    it('handles tool result messages', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'What time is it?' }] },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-123',
                toolName: 'get_time',
                result: { time: '12:00' },
              },
            ],
          },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result.finishReason).toBe('stop');
    });

    it('handles empty prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('respects maxTokens from options', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
        maxTokens: 100,
      };

      const result = await model.doGenerate(options);
      expect(result.rawCall.rawSettings).toHaveProperty('maxNewTokens', 100);
    });

    it('respects temperature from options', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
        temperature: 0.8,
      };

      const result = await model.doGenerate(options);
      expect(result.rawCall.rawSettings).toHaveProperty('temperature', 0.8);
    });

    it('handles tools in regular mode', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'What time?' }] }],
        mode: {
          type: 'regular',
          tools: [
            {
              type: 'function',
              name: 'get_time',
              description: 'Get current time',
              parameters: {
                type: 'object',
                properties: {
                  timezone: { type: 'string' },
                },
              },
            },
          ],
        },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('filters non-function tools', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: {
          type: 'regular',
          tools: [
            { type: 'other' as any }, // Non-function tool should be filtered
            {
              type: 'function',
              name: 'test_tool',
              description: 'Test',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('passes abortSignal to backend', async () => {
      const model = new LocalLanguageModel('test-model');
      const abortController = new AbortController();
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
        abortSignal: abortController.signal,
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });
  });

  describe('doStream', () => {
    it('returns a stream result', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doStream(options);
      expect(result).toHaveProperty('stream');
      expect(result).toHaveProperty('rawCall');
    });

    it('stream contains text-delta part', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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

      const textDeltaPart = parts.find((p: any) => p.type === 'text-delta');
      expect(textDeltaPart).toBeDefined();
    });

    it('stream contains finish part', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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

      const finishPart = parts.find((p: any) => p.type === 'finish');
      expect(finishPart).toBeDefined();
      expect((finishPart as any).finishReason).toBe('stop');
    });
  });

  describe('message conversion edge cases', () => {
    it('handles null in prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [null as any, { role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles undefined in prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [undefined as any, { role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles primitive in prompt array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          'string' as any,
          123 as any,
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles empty content array', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles non-array content', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: 'string content' as any }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles multiple text parts', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Part 1' },
              { type: 'text', text: 'Part 2' },
            ],
          },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('filters non-text parts', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          {
            role: 'user',
            content: [
              { type: 'image', image: 'data:...' } as any,
              { type: 'text', text: 'Describe this' },
            ],
          },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool result with string result', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'test',
                result: 'string result',
              },
            ],
          },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool result with object result', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'test',
                result: { data: 'value' },
              },
            ],
          },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool content without tool-result type', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          {
            role: 'tool',
            content: [{ type: 'other', data: 'value' } as any],
          },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result).toHaveProperty('finishReason');
    });

    it('handles tool result without toolCallId', async () => {
      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolName: 'test',
                result: 'result',
              } as any,
            ],
          },
        ],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result.finishReason).toBe('tool-calls');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls?.[0].toolName).toBe('test');
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Weather in London?' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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

      const toolCallPart = parts.find((p: any) => p.type === 'tool-call');
      expect(toolCallPart).toBeDefined();
      expect((toolCallPart as any).toolName).toBe('get_weather');
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: {
          type: 'regular',
          tools: [],
        },
        inputFormat: 'messages',
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
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
      };

      const result = await model.doGenerate(options);
      expect(result.text).toBeUndefined();
    });

    it('stream handles result with no text', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      });

      const model = new LocalLanguageModel('test-model');
      const options: LanguageModelV1CallOptions = {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        mode: { type: 'regular' },
        inputFormat: 'messages',
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
