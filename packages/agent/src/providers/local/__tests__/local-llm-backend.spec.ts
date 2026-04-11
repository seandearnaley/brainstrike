import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalLlmBackend, verifyModelIntegrity } from '../local-llm-backend';
import { GEMMA4_E2B_MODEL_ID } from '../local-model-specs';

const mockProcessorApplyChatTemplate = vi.fn();
const mockProcessorCall = vi.fn();
const mockBatchDecode = vi.fn();
const mockTokenizerDecode = vi.fn();
const mockTokenizerEncode = vi.fn();
const mockModelGenerate = vi.fn();
const mockFromPretrainedProcessor = vi.fn();
const mockFromPretrainedModel = vi.fn();
const mockTokenizer = Object.assign(
  () => {
    throw new Error('Tokenizer callable should not be used directly for Gemma text inputs');
  },
  {
    decode: mockTokenizerDecode,
    encode: mockTokenizerEncode,
  }
);
const mockProcessor = {
  apply_chat_template: mockProcessorApplyChatTemplate,
  batch_decode: mockBatchDecode,
  tokenizer: mockTokenizer,
  call: mockProcessorCall,
};
const mockGemmaLoader = {
  from_pretrained: mockFromPretrainedModel,
};
const mockAutoProcessor = {
  from_pretrained: mockFromPretrainedProcessor,
};
const mockTextStreamerCtor = vi.fn(function MockTextStreamer(
  _tokenizer: unknown,
  options: { callback_function?: (text: string) => void }
) {
  return {
    callback_function: options.callback_function,
  };
});
const callableProcessor = Object.assign(
  (prompt: unknown, images: unknown, audio: unknown, options: unknown) =>
    mockProcessorCall.call(mockProcessor, prompt, images, audio, options),
  mockProcessor,
  {
    bind: undefined,
  }
);

function isProcessorOwner(value: unknown): boolean {
  return value === mockProcessor || value === callableProcessor;
}

vi.mock('@huggingface/transformers', () => ({
  AutoProcessor: mockAutoProcessor,
  Gemma4ForCausalLM: mockGemmaLoader,
  Gemma4ForConditionalGeneration: mockGemmaLoader,
  TextStreamer: mockTextStreamerCtor,
}));

function installNavigatorWebGpu(hasGpu: boolean): void {
  vi.stubGlobal(
    'navigator',
    hasGpu
      ? {
          gpu: {
            requestAdapter: vi.fn().mockResolvedValue({
              info: {
                vendor: 'test-vendor',
                architecture: 'test-arch',
                device: 'test-device',
                description: 'test-description',
              },
              limits: {
                maxBufferSize: 8_000_000_000,
                maxStorageBufferBindingSize: 8_000_000_000,
              },
            }),
          },
          storage: {
            estimate: vi.fn().mockResolvedValue({
              quota: 10_000_000_000,
              usage: 0,
            }),
          },
        }
      : {
          storage: {
            estimate: vi.fn().mockResolvedValue({
              quota: 10_000_000_000,
              usage: 0,
            }),
          },
        }
  );
}

describe('LocalLlmBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installNavigatorWebGpu(true);

    mockProcessorApplyChatTemplate.mockImplementation(function (
      this: unknown,
      _messages: unknown,
      _options: unknown
    ) {
      if (!isProcessorOwner(this)) {
        throw new TypeError('this is not a constructor');
      }
      return 'PROMPT';
    });
    mockProcessorCall.mockImplementation(async function (
      this: unknown,
      _prompt: unknown,
      _images: unknown,
      _audio: unknown,
      _options: unknown
    ) {
      if (!isProcessorOwner(this)) {
        throw new TypeError('this is not a constructor');
      }
      return {
        input_ids: {
          dims: [1, 4],
        },
      };
    });
    mockBatchDecode.mockImplementation(function (
      this: unknown,
      _tokens: unknown,
      _options: unknown
    ) {
      if (!isProcessorOwner(this)) {
        throw new TypeError('this is not a constructor');
      }
      return ['<|channel|>thought\ninternal reasoning<channel|>Final answer'];
    });
    mockTokenizerDecode.mockImplementation(function (
      this: typeof mockTokenizer,
      tokens: readonly bigint[]
    ) {
      if (this !== mockTokenizer) {
        throw new TypeError('this is not a constructor');
      }
      return tokens.map((token) => String.fromCharCode(Number(token))).join('');
    });
    mockTokenizerEncode.mockImplementation(function (this: typeof mockTokenizer, text: string) {
      if (this !== mockTokenizer) {
        throw new TypeError('this is not a constructor');
      }
      return Array.from(text);
    });
    mockModelGenerate.mockImplementation(async function (
      this: { generate: typeof mockModelGenerate },
      inputs: { streamer?: { callback_function?: (text: string) => void } }
    ) {
      if (this.generate !== mockModelGenerate) {
        throw new TypeError('this is not a constructor');
      }
      inputs.streamer?.callback_function?.('<|channel|>thought\n');
      inputs.streamer?.callback_function?.('internal reasoning');
      inputs.streamer?.callback_function?.('<channel|>');
      inputs.streamer?.callback_function?.('Final answer');
      return {
        slice: vi.fn().mockReturnValue('TOKENS'),
      };
    });

    mockFromPretrainedProcessor.mockImplementation(async function (
      this: typeof mockAutoProcessor,
      _modelId: string,
      _options: unknown
    ) {
      if (this !== mockAutoProcessor) {
        throw new TypeError('this is not a constructor');
      }
      return callableProcessor;
    });
    mockFromPretrainedModel.mockImplementation(async function (
      this: typeof mockGemmaLoader,
      _modelId: string,
      _options: unknown
    ) {
      if (this !== mockGemmaLoader) {
        throw new TypeError('this is not a constructor');
      }
      return {
        generate: mockModelGenerate,
      };
    });
  });

  it('rejects removed legacy local models', async () => {
    const backend = new LocalLlmBackend();

    await expect(
      backend.initialize({
        modelId: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
      })
    ).rejects.toThrow('unsupported built-in local model');
  });

  it('requires WebGPU for Gemma instead of silently falling back to wasm', async () => {
    installNavigatorWebGpu(false);
    const backend = new LocalLlmBackend();

    await expect(
      backend.initialize({
        modelId: GEMMA4_E2B_MODEL_ID,
      })
    ).rejects.toThrow('webgpu_unavailable');
  });

  it('strips Gemma thought traces from generated text', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ role: 'user', content: 'Hello' }], {
      thinking: {
        enabled: true,
      },
    });

    expect(result.text).toBe('Final answer');
    expect(result.reasoningText).toBe('internal reasoning');
    expect(mockProcessorApplyChatTemplate).toHaveBeenCalledWith(
      [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      {
        add_generation_prompt: true,
        enable_thinking: true,
      }
    );
    expect(mockProcessorCall).toHaveBeenCalledWith('PROMPT', null, null, {
      add_special_tokens: false,
    });
  });

  it('streams official channel-delimited reasoning snapshots before the final answer', async () => {
    const backend = new LocalLlmBackend();
    const reasoningSnapshots: string[] = [];
    const textSnapshots: string[] = [];

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ role: 'user', content: 'Tell me a joke' }], {
      stream: {
        onReasoningSnapshot: (snapshot) => {
          reasoningSnapshots.push(snapshot);
        },
        onTextSnapshot: (snapshot) => {
          textSnapshots.push(snapshot);
        },
      },
      thinking: { enabled: true },
    });

    expect(reasoningSnapshots).toEqual(['internal reasoning']);
    expect(textSnapshots).toEqual(['Final answer']);
    expect(result.reasoningText).toBe('internal reasoning');
    expect(result.text).toBe('Final answer');
  });

  it('strips observed Gemma channel and turn markers from visible output', async () => {
    mockBatchDecode.mockReturnValue([
      `<|channel>thought Thinking Process:

Analyze the Request: The user asked for "a joke."
Determine the Goal: Provide a joke that is generally funny, accessible, and appropriate.
Final Output Generation: (Construct the joke and deliver it.)<channel|>Why don't scientists trust atoms?
Because they make up everything!<turn|>`,
    ]);
    mockModelGenerate.mockImplementation(async function (
      this: { generate: typeof mockModelGenerate },
      inputs: { streamer?: { callback_function?: (text: string) => void } }
    ) {
      if (this.generate !== mockModelGenerate) {
        throw new TypeError('this is not a constructor');
      }
      inputs.streamer?.callback_function?.('<|channel>thought ');
      inputs.streamer?.callback_function?.('Thinking Process:\n\nAnalyze the Request.');
      inputs.streamer?.callback_function?.('<channel|>');
      inputs.streamer?.callback_function?.(
        "Why don't scientists trust atoms?\nBecause they make up everything!<turn|>"
      );
      return {
        slice: vi.fn().mockReturnValue('TOKENS'),
      };
    });
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const reasoningSnapshots: string[] = [];
    const textSnapshots: string[] = [];
    const result = await backend.generate([{ role: 'user', content: 'Tell me a joke' }], {
      stream: {
        onReasoningSnapshot: (snapshot) => {
          reasoningSnapshots.push(snapshot);
        },
        onTextSnapshot: (snapshot) => {
          textSnapshots.push(snapshot);
        },
      },
      thinking: { enabled: true },
    });

    expect(reasoningSnapshots.at(-1)).toContain('Analyze the Request');
    expect(textSnapshots.at(-1)).toBe(
      "Why don't scientists trust atoms?\nBecause they make up everything!"
    );
    expect(result.reasoningText).toContain('Determine the Goal');
    expect(result.text).toBe("Why don't scientists trust atoms?\nBecause they make up everything!");
  });

  it('strips eos-style control markers from streamed and final visible output', async () => {
    mockBatchDecode.mockReturnValue(['Visible answer</eos>']);
    mockModelGenerate.mockImplementation(async function (
      this: { generate: typeof mockModelGenerate },
      inputs: { streamer?: { callback_function?: (text: string) => void } }
    ) {
      if (this.generate !== mockModelGenerate) {
        throw new TypeError('this is not a constructor');
      }
      inputs.streamer?.callback_function?.('Visible answer</eos>');
      return {
        slice: vi.fn().mockReturnValue('TOKENS'),
      };
    });

    const backend = new LocalLlmBackend();
    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const textSnapshots: string[] = [];
    const result = await backend.generate([{ role: 'user', content: 'Tell me a joke' }], {
      stream: {
        onTextSnapshot: (snapshot) => {
          textSnapshots.push(snapshot);
        },
      },
      thinking: { enabled: false },
    });

    expect(textSnapshots.at(-1)).toBe('Visible answer');
    expect(result.text).toBe('Visible answer');
  });

  it('binds Transformers.js loaders and runtime methods to their owners', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await expect(
      backend.generate([{ role: 'user', content: 'Tell me a joke' }], {
        tools: [
          {
            type: 'function',
            function: {
              name: 'tell_joke',
              description: 'Return a joke',
              parameters: {
                type: 'object',
                properties: {
                  topic: { type: 'string' },
                },
                required: ['topic'],
              },
            },
          },
        ],
      })
    ).resolves.toMatchObject({
      finishReason: 'stop',
      text: 'Final answer',
    });

    expect(mockProcessorApplyChatTemplate).toHaveBeenLastCalledWith(
      [
        {
          role: 'user',
          content: 'Tell me a joke',
        },
      ],
      {
        add_generation_prompt: true,
        enable_thinking: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'tell_joke',
              description: 'Return a joke',
              parameters: {
                type: 'object',
                properties: {
                  topic: { type: 'string' },
                },
                required: ['topic'],
              },
            },
          },
        ],
      }
    );
  });

  it('supports callable processor instances without Function.bind', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await expect(
      backend.generate([{ role: 'user', content: 'Tell me another joke' }], {
        thinking: {
          enabled: false,
        },
      })
    ).resolves.toMatchObject({
      finishReason: 'stop',
      text: 'Final answer',
    });
  });

  it('uses the processor text-only call signature from the Gemma docs', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await expect(
      backend.generate([{ role: 'user', content: 'Tell me a joke' }], {
        thinking: {
          enabled: false,
        },
      })
    ).resolves.toMatchObject({
      finishReason: 'stop',
      text: 'Final answer',
    });

    expect(mockProcessorCall).toHaveBeenCalledWith('PROMPT', null, null, {
      add_special_tokens: false,
    });
  });

  it('parses Gemma tool calls into local tool results', async () => {
    mockBatchDecode.mockReturnValue([
      '<|tool_call|>call:tell_joke{topic: <|"|>penguins<|"|>}<tool_call|>',
    ]);

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ role: 'user', content: 'Tell me a joke' }], {
      tools: [
        {
          type: 'function',
          function: {
            name: 'tell_joke',
            description: 'Return a joke',
            parameters: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
              },
              required: ['topic'],
            },
          },
        },
      ],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.text).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.function).toEqual({
      name: 'tell_joke',
      arguments: JSON.stringify({ topic: 'penguins' }),
    });
  });

  it('ignores Gemma tool call payloads whose function name trims to empty', async () => {
    mockBatchDecode.mockReturnValue([
      '<|tool_call|>call:   {topic: <|"|>penguins<|"|>}<tool_call|>',
    ]);

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ role: 'user', content: 'Tell me a joke' }], {
      tools: [
        {
          type: 'function',
          function: {
            name: 'tell_joke',
            description: 'Return a joke',
            parameters: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
              },
              required: ['topic'],
            },
          },
        },
      ],
    });

    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
    expect(result.text).toBe('');
  });

  it('parses nested Gemma tool call arguments without swallowing trailing text', async () => {
    mockBatchDecode.mockReturnValue([
      '<|tool_call|>call:read_file{path: <|"|>/README.md<|"|>, options: {encoding: <|"|>utf8<|"|>}} trailing text<tool_call|>',
    ]);

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ role: 'user', content: 'Read the readme' }], {
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                options: {
                  type: 'object',
                  properties: {
                    encoding: { type: 'string' },
                  },
                },
              },
              required: ['path'],
            },
          },
        },
      ],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0]?.function).toEqual({
      name: 'read_file',
      arguments: JSON.stringify({
        path: '/README.md',
        options: {
          encoding: 'utf8',
        },
      }),
    });
  });

  it('formats assistant tool calls and tool responses using Gemma chat template fields', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await expect(
      backend.generate(
        [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tool-1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: '/README.md' }),
                },
              },
            ],
          },
          {
            role: 'tool',
            content: '',
            toolResponses: [
              {
                name: 'read_file',
                response: {
                  success: true,
                  result: 'hello',
                },
              },
            ],
          },
        ],
        {
          thinking: {
            enabled: false,
          },
        }
      )
    ).resolves.toMatchObject({
      finishReason: 'stop',
      text: 'Final answer',
    });

    expect(mockProcessorApplyChatTemplate).toHaveBeenLastCalledWith(
      [
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                arguments: {
                  path: '/README.md',
                },
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_responses: [
            {
              name: 'read_file',
              response: {
                success: true,
                result: 'hello',
              },
            },
          ],
        },
      ],
      {
        add_generation_prompt: true,
        enable_thinking: false,
      }
    );
  });

  it('fails closed when legacy integrity verification is invoked', async () => {
    await expect(verifyModelIntegrity(GEMMA4_E2B_MODEL_ID, new ArrayBuffer(8))).resolves.toBe(
      false
    );
  });
});
