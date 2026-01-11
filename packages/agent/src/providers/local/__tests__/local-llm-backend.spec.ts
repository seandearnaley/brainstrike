import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalLlmBackend } from '../local-llm-backend';
import type { LocalLlmConfig, LocalLlmGenerationOptions, LocalLlmMessage } from '../types';

// Mock the transformers module
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  AutoTokenizer: {
    from_pretrained: vi.fn(),
  },
}));

/**
 * Create a mock tokenizer for tests.
 * The tokenizer is required for token counting in generate().
 */
function createMockTokenizer() {
  return {
    encode: vi.fn((text: string) => {
      // Approximate token count: ~4 chars per token
      const tokenCount = Math.ceil(text.length / 4);
      return new Array(tokenCount).fill(0);
    }),
  };
}

describe('LocalLlmBackend', () => {
  let backend: LocalLlmBackend;

  beforeEach(() => {
    backend = new LocalLlmBackend();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await backend.dispose();
  });

  describe('device detection', () => {
    it('returns wasm when WebAssembly is available', () => {
      expect(LocalLlmBackend.isDeviceAvailable('wasm')).toBe(true);
    });

    it('returns false for webgpu in Node environment', () => {
      // In Node.js, navigator is not defined
      expect(LocalLlmBackend.isDeviceAvailable('webgpu')).toBe(false);
    });

    it('getBestDevice returns wasm in Node environment', () => {
      expect(LocalLlmBackend.getBestDevice()).toBe('wasm');
    });
  });

  describe('status management', () => {
    it('starts in uninitialized state', () => {
      expect(backend.getStatus()).toEqual({ state: 'uninitialized' });
    });

    it('isReady returns false when not initialized', () => {
      expect(backend.isReady()).toBe(false);
    });

    it('getModelId returns null when not initialized', () => {
      expect(backend.getModelId()).toBe(null);
    });
  });

  describe('generate', () => {
    it('throws error when not initialized', async () => {
      const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];

      await expect(backend.generate(messages)).rejects.toThrow(
        'Model not initialized. Call initialize() first.'
      );
    });

    it('throws AbortError when signal is aborted before generation', async () => {
      // Setup mock pipeline and tokenizer
      const mockPipeline = vi.fn().mockResolvedValue([{ generated_text: 'test' }]);
      (backend as any).pipeline = mockPipeline;
      (backend as any).tokenizer = createMockTokenizer();
      (backend as any).modelId = 'test-model';
      (backend as any).selectedDevice = 'wasm';
      (backend as any).status = { state: 'ready', device: 'wasm' };

      const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
      const abortController = new AbortController();
      abortController.abort();

      const options: LocalLlmGenerationOptions = {
        signal: abortController.signal,
      };

      await expect(backend.generate(messages, options)).rejects.toThrow('Generation aborted');
    });
  });

  describe('dispose', () => {
    it('resets state after dispose', async () => {
      // Set some state
      const mockPipeline = { dispose: vi.fn() };
      (backend as any).pipeline = mockPipeline;
      (backend as any).modelId = 'test-model';
      (backend as any).selectedDevice = 'wasm';
      (backend as any).status = { state: 'ready', device: 'wasm' };

      await backend.dispose();

      expect(backend.getStatus()).toEqual({ state: 'uninitialized' });
      expect(backend.getModelId()).toBe(null);
      expect(backend.isReady()).toBe(false);
    });

    it('handles dispose errors gracefully', async () => {
      const mockPipeline = {
        dispose: vi.fn().mockRejectedValue(new Error('Dispose failed')),
      };

      (backend as any).pipeline = mockPipeline;

      // Should not throw
      await expect(backend.dispose()).resolves.toBeUndefined();
      expect(backend.getStatus()).toEqual({ state: 'uninitialized' });
    });

    it('handles pipeline without dispose method', async () => {
      (backend as any).pipeline = {}; // No dispose method

      // Should not throw
      await expect(backend.dispose()).resolves.toBeUndefined();
    });
  });
});

describe('pipeline-based generation', () => {
  let backend: LocalLlmBackend;

  beforeEach(() => {
    backend = new LocalLlmBackend();
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('generates text from pipeline output', async () => {
    const mockPipeline = vi
      .fn()
      .mockResolvedValue([{ generated_text: 'Hello! How can I help you today?' }]);

    (backend as any).pipeline = mockPipeline;
    (backend as any).tokenizer = createMockTokenizer();
    (backend as any).modelId = 'test-model';
    (backend as any).selectedDevice = 'wasm';
    (backend as any).status = { state: 'ready', device: 'wasm' };

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await backend.generate(messages);

    expect(result.text).toBe('Hello! How can I help you today?');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toBeDefined();
  });

  it('handles array response format from pipeline', async () => {
    const mockPipeline = vi.fn().mockResolvedValue([
      {
        generated_text: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      },
    ]);

    (backend as any).pipeline = mockPipeline;
    (backend as any).tokenizer = createMockTokenizer();
    (backend as any).modelId = 'test-model';
    (backend as any).selectedDevice = 'wasm';
    (backend as any).status = { state: 'ready', device: 'wasm' };

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await backend.generate(messages);

    expect(result.text).toBe('Hi there!');
    expect(result.finishReason).toBe('stop');
  });

  it('returns usage statistics', async () => {
    const mockPipeline = vi.fn().mockResolvedValue([{ generated_text: 'test output' }]);

    (backend as any).pipeline = mockPipeline;
    (backend as any).tokenizer = createMockTokenizer();
    (backend as any).modelId = 'test-model';
    (backend as any).selectedDevice = 'wasm';
    (backend as any).status = { state: 'ready', device: 'wasm' };

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await backend.generate(messages);

    expect(result.usage).toBeDefined();
    expect(typeof result.usage.promptTokens).toBe('number');
    expect(typeof result.usage.completionTokens).toBe('number');
  });
});

describe('tool call parsing', () => {
  let backend: LocalLlmBackend;

  beforeEach(() => {
    backend = new LocalLlmBackend();
    (backend as any).tokenizer = createMockTokenizer();
    (backend as any).modelId = 'test-model';
    (backend as any).selectedDevice = 'wasm';
    (backend as any).status = { state: 'ready', device: 'wasm' };
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('parses FunctionGemma format tool calls', async () => {
    const mockPipeline = vi.fn().mockResolvedValue([
      {
        generated_text: '<start_function_call>call:search{query:test search}<end_function_call>',
      },
    ]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Search for test' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'search',
      },
    });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('parses Qwen format tool calls', async () => {
    const mockPipeline = vi
      .fn()
      .mockResolvedValue([
        { generated_text: '<tool_call>{"name":"search","arguments":{"query":"test"}}</tool_call>' },
      ]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Search for test' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'search',
        arguments: '{"query":"test"}',
      },
    });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('parses generic JSON format tool calls', async () => {
    const mockPipeline = vi
      .fn()
      .mockResolvedValue([
        { generated_text: '{"name": "search", "arguments": {"query": "test"}}' },
      ]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Search for test' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'search',
      },
    });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('parses LFM2.5 Pythonic format with string arguments', async () => {
    const mockPipeline = vi
      .fn()
      .mockResolvedValue([
        { generated_text: '<|tool_call_start|>[get_weather(location="Paris")]<|tool_call_end|>' },
      ]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Weather in Paris?' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'get_weather',
      },
    });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('parses LFM2.5 format with multiple kwargs', async () => {
    const mockPipeline = vi.fn().mockResolvedValue([
      {
        generated_text: '<|tool_call_start|>[search(query="AI news", limit=10)]<|tool_call_end|>',
      },
    ]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Search AI' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0]?.function.name).toBe('search');
    // Arguments should be serialized JSON
    const args = JSON.parse(result.toolCalls?.[0]?.function.arguments ?? '{}');
    expect(args.query).toBe('AI news');
    expect(args.limit).toBe(10);
  });

  it('parses LFM2.5 format with boolean arguments', async () => {
    const mockPipeline = vi
      .fn()
      .mockResolvedValue([
        { generated_text: '<|tool_call_start|>[toggle(enabled=true)]<|tool_call_end|>' },
      ]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Enable' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeDefined();
    const args = JSON.parse(result.toolCalls?.[0]?.function.arguments ?? '{}');
    expect(args.enabled).toBe(true);
  });

  it('returns no tool calls for plain text output', async () => {
    const mockPipeline = vi
      .fn()
      .mockResolvedValue([
        { generated_text: 'This is a plain text response without any tool calls' },
      ]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('This is a plain text response without any tool calls');
  });
});

describe('initialize error handling', () => {
  let backend: LocalLlmBackend;

  beforeEach(() => {
    backend = new LocalLlmBackend();
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('throws error when WebGPU is requested but unavailable', async () => {
    const config: LocalLlmConfig = {
      modelId: 'test/model',
      device: 'webgpu',
    };

    await expect(backend.initialize(config)).rejects.toThrow('WebGPU requested but not available');
  });

  it('throws error for invalid model ID format', async () => {
    const config: LocalLlmConfig = {
      modelId: 'invalid-model-no-slash',
      device: 'wasm',
    };

    await expect(backend.initialize(config)).rejects.toThrow(
      'Invalid model ID format: "invalid-model-no-slash". Expected format: "owner/model-name"'
    );
  });

  it('throws error for model ID with path traversal', async () => {
    const config: LocalLlmConfig = {
      modelId: '../malicious/path',
      device: 'wasm',
    };

    await expect(backend.initialize(config)).rejects.toThrow('Invalid model ID format');
  });
});

describe('WebGPU info retrieval', () => {
  it('returns null when navigator.gpu is not available', async () => {
    const info = await LocalLlmBackend.getWebGpuInfo();
    // In Node.js environment, WebGPU is not available
    expect(info).toBe(null);
  });
});

describe('generation with tools', () => {
  let backend: LocalLlmBackend;

  beforeEach(() => {
    backend = new LocalLlmBackend();

    const mockPipeline = vi
      .fn()
      .mockResolvedValue([{ generated_text: 'I will help you with that.' }]);

    (backend as any).pipeline = mockPipeline;
    (backend as any).tokenizer = createMockTokenizer();
    (backend as any).modelId = 'test-model';
    (backend as any).selectedDevice = 'wasm';
    (backend as any).status = { state: 'ready', device: 'wasm' };
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('includes tool definitions when provided', async () => {
    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Search for something' }];
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'search',
          description: 'Search for information',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
      },
    ];

    const result = await backend.generate(messages, { tools });

    expect(result.text).toBeDefined();
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
  });
});

describe('edge cases in tool call parsing', () => {
  let backend: LocalLlmBackend;

  beforeEach(() => {
    backend = new LocalLlmBackend();
    (backend as any).tokenizer = createMockTokenizer();
    (backend as any).modelId = 'test-model';
    (backend as any).selectedDevice = 'wasm';
    (backend as any).status = { state: 'ready', device: 'wasm' };
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('handles malformed JSON gracefully', async () => {
    const mockPipeline = vi
      .fn()
      .mockResolvedValue([{ generated_text: '{"name": "search", "arguments": {invalid json}' }]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Search' }];
    const result = await backend.generate(messages);

    // Should return text, not parse as tool call due to invalid JSON
    expect(result.text).toBeDefined();
    expect(result.finishReason).toBe('stop');
  });

  it('handles empty response', async () => {
    const mockPipeline = vi.fn().mockResolvedValue([{ generated_text: '' }]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await backend.generate(messages);

    expect(result.text).toBe('');
    expect(result.finishReason).toBe('stop');
  });

  it('handles response with only whitespace', async () => {
    const mockPipeline = vi.fn().mockResolvedValue([{ generated_text: '   \n\n   ' }]);
    (backend as any).pipeline = mockPipeline;

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await backend.generate(messages);

    expect(result.text).toBeDefined();
    expect(result.finishReason).toBe('stop');
  });
});

describe('concurrent operations', () => {
  it('handles multiple backend instances independently', async () => {
    const backend1 = new LocalLlmBackend();
    const backend2 = new LocalLlmBackend();

    expect(backend1.getStatus().state).toBe('uninitialized');
    expect(backend2.getStatus().state).toBe('uninitialized');

    // Both should be independent
    (backend1 as any).status = { state: 'ready', device: 'wasm' };

    expect(backend1.getStatus().state).toBe('ready');
    expect(backend2.getStatus().state).toBe('uninitialized');

    await backend1.dispose();
    await backend2.dispose();
  });
});

describe('model configuration', () => {
  it('backend instantiation succeeds', () => {
    const backend = new LocalLlmBackend();
    expect(backend).toBeDefined();
    expect(backend.getStatus().state).toBe('uninitialized');
  });
});
