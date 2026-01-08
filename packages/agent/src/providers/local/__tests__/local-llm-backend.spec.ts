import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalLlmBackend } from '../local-llm-backend';
import type { LocalLlmConfig, LocalLlmGenerationOptions, LocalLlmMessage } from '../types';

// Mock the transformers module
vi.mock('@huggingface/transformers', () => ({
  AutoModelForCausalLM: {
    from_pretrained: vi.fn(),
  },
  AutoTokenizer: {
    from_pretrained: vi.fn(),
  },
}));

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

    it('throws AbortError when signal is aborted', async () => {
      // Setup mock model and tokenizer
      const mockTokenizer = {
        apply_chat_template: vi.fn().mockReturnValue({
          input_ids: { dims: [1, 5], data: [], slice: vi.fn() },
          attention_mask: { dims: [1, 5], data: [] },
        }),
        decode: vi.fn().mockReturnValue('test output'),
      };

      const mockModel = {
        generate: vi.fn().mockResolvedValue([]),
        dispose: vi.fn(),
      };

      // Access private properties to set mocks (for testing only)
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).model = mockModel;
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).tokenizer = mockTokenizer;
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
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
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).model = { dispose: vi.fn() };
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).tokenizer = {};
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).modelId = 'test-model';
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).selectedDevice = 'wasm';
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).status = { state: 'ready', device: 'wasm' };

      await backend.dispose();

      expect(backend.getStatus()).toEqual({ state: 'uninitialized' });
      expect(backend.getModelId()).toBe(null);
      expect(backend.isReady()).toBe(false);
    });

    it('handles dispose errors gracefully', async () => {
      const mockModel = {
        dispose: vi.fn().mockRejectedValue(new Error('Dispose failed')),
      };

      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).model = mockModel;

      // Should not throw
      await expect(backend.dispose()).resolves.toBeUndefined();
      expect(backend.getStatus()).toEqual({ state: 'uninitialized' });
    });

    it('handles model without dispose method', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
      (backend as any).model = {}; // No dispose method

      // Should not throw
      await expect(backend.dispose()).resolves.toBeUndefined();
    });
  });
});

describe('parseFunctionCall formats', () => {
  let backend: LocalLlmBackend;

  beforeEach(() => {
    backend = new LocalLlmBackend();

    // Setup mock model and tokenizer
    const mockTokenizer = {
      apply_chat_template: vi.fn().mockReturnValue({
        input_ids: { dims: [1, 5], data: [], slice: vi.fn().mockReturnValue([]) },
        attention_mask: { dims: [1, 5], data: [] },
      }),
      decode: vi.fn(),
    };

    const mockModel = {
      generate: vi.fn().mockResolvedValue([]),
      dispose: vi.fn(),
    };

    // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
    (backend as any).model = mockModel;
    // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
    (backend as any).tokenizer = mockTokenizer;
    // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
    (backend as any).status = { state: 'ready', device: 'wasm' };
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('parses FunctionGemma format tool calls', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
    const tokenizer = (backend as any).tokenizer;
    tokenizer.decode
      .mockReturnValueOnce('<start_function_call>call:search{query:test search}<end_function_call>')
      .mockReturnValueOnce('');

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
    // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
    const tokenizer = (backend as any).tokenizer;
    tokenizer.decode
      .mockReturnValueOnce('<tool_call>{"name":"search","arguments":{"query":"test"}}</tool_call>')
      .mockReturnValueOnce('');

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
  });

  it('parses generic JSON format tool calls', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
    const tokenizer = (backend as any).tokenizer;
    tokenizer.decode
      .mockReturnValueOnce('{"name": "search", "arguments": {"query": "test"}}')
      .mockReturnValueOnce('');

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Search for test' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'search',
      },
    });
  });

  it('returns no tool calls for plain text output', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Test-only access to private properties
    const tokenizer = (backend as any).tokenizer;
    tokenizer.decode
      .mockReturnValueOnce('This is a plain text response without any tool calls')
      .mockReturnValueOnce('This is a plain text response');

    const messages: LocalLlmMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await backend.generate(messages);

    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('This is a plain text response');
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
      modelId: 'test-model',
      device: 'webgpu',
    };

    await expect(backend.initialize(config)).rejects.toThrow('WebGPU requested but not available');
  });
});
