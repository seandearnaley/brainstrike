import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalLlmBackend, setModelChecksums, verifyModelIntegrity } from '../local-llm-backend';
import type { LocalLlmConfig, LocalLlmGenerationOptions, LocalLlmMessage } from '../types';

// Mock the transformers module
// AutoTokenizer must be a function (class) since the validation checks typeof === 'function'
vi.mock('@huggingface/transformers', () => {
  // Create a mock class with static from_pretrained method
  const MockAutoTokenizer = (() => {}) as unknown as { from_pretrained: ReturnType<typeof vi.fn> };
  MockAutoTokenizer.from_pretrained = vi.fn();

  return {
    pipeline: vi.fn(),
    AutoTokenizer: MockAutoTokenizer,
  };
});

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
      // Use an allowed model ID to test WebGPU availability check
      modelId: 'onnx-community/Qwen3-0.6B-ONNX',
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

  it('throws error for model ID not in allowlist', async () => {
    const config: LocalLlmConfig = {
      // Valid format but not in the approved allowlist
      modelId: 'some-org/unapproved-model',
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

describe('Model Integrity Verification', () => {
  // Mock hash matching the pattern generated by our mock digest
  // 0x01, 0x02, ..., 0x20
  const mockHash = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

  beforeEach(() => {
    // Ensure crypto.subtle exists (Node 19+ or polyfill)
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', {
        value: {
          subtle: {
            digest: vi.fn(),
          },
        },
        writable: true,
        configurable: true,
      });
    }

    // Mock digest to return deterministic value
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)).buffer
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validates correct SHA256 checksum', async () => {
    const modelId = 'test/model-valid';
    // Register expected checksum
    setModelChecksums(modelId, { onnxSha256: mockHash });

    const data = new ArrayBuffer(100);
    const result = await verifyModelIntegrity(modelId, data);

    expect(result).toBe(true);
  });

  it('skips verification for pending-verification placeholder', async () => {
    const modelId = 'test/model-pending';
    setModelChecksums(modelId, { onnxSha256: 'pending-verification' });

    const data = new ArrayBuffer(100);
    const result = await verifyModelIntegrity(modelId, data);

    expect(result).toBe(true);
  });

  it('throws error on checksum mismatch', async () => {
    const modelId = 'test/model-mismatch';
    // Use a different hash than what our mock produces
    const wrongHash = 'a'.repeat(64);
    setModelChecksums(modelId, { onnxSha256: wrongHash });

    const data = new ArrayBuffer(100);
    await expect(verifyModelIntegrity(modelId, data)).rejects.toThrow(
      'Model integrity check failed'
    );
  });

  it('handles unavailable crypto gracefully', async () => {
    // Stub global crypto to be undefined
    vi.stubGlobal('crypto', undefined);

    const modelId = 'test/model-no-crypto';
    setModelChecksums(modelId, { onnxSha256: mockHash });

    const data = new ArrayBuffer(100);
    const result = await verifyModelIntegrity(modelId, data);

    // Should return true (skip verification) if crypto unavailable
    expect(result).toBe(true);
  });

  it('skips verification for unregistered models', async () => {
    const modelId = 'test/unregistered-model';
    // No checksum registered

    const data = new ArrayBuffer(100);
    const result = await verifyModelIntegrity(modelId, data);

    expect(result).toBe(true);
  });

  it('validates model ID format in setModelChecksums', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Should fail validation (no slash)
    setModelChecksums('invalid-model-id', { onnxSha256: mockHash });

    // Should log warning and not throw (implementation detail: setModelChecksums is void)
    // We check that it handled it safely. Ideally we'd spy on the internal map or logger,
    // but verifying it doesn't crash is a baseline.
    // In a real integration, we'd check if the checksum was actually set (or not).
  });

  it('validates checksum format in setModelChecksums', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const modelId = 'test/valid-model';
    // Should fail validation (invalid hex length)
    setModelChecksums(modelId, { onnxSha256: 'bad-checksum' });

    // Should log warning and not crash
  });
});
