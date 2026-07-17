import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAllowedModels,
  getAllowedModels,
  isModelAllowed,
  LocalLlmBackend,
  setModelChecksums,
  verifyModelIntegrity,
} from '../local-llm-backend';
import { GEMMA4_E2B_MODEL_ID } from '../local-model-specs';

const { mockArtifactDownload, mockHasRequiredArtifacts } = vi.hoisted(() => ({
  mockArtifactDownload: vi.fn(),
  mockHasRequiredArtifacts: vi.fn(),
}));

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
  call: mockProcessorCall,
  tokenizer: mockTokenizer,
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

vi.mock('../local-artifact-store', () => ({
  createLocalArtifactStore: () => ({
    download: mockArtifactDownload,
    hasRequiredArtifacts: mockHasRequiredArtifacts,
  }),
}));

function installNavigatorWebGpu(hasGpu: boolean): void {
  vi.stubGlobal(
    'navigator',
    hasGpu
      ? {
          gpu: {
            requestAdapter: vi.fn().mockResolvedValue({
              info: {
                architecture: 'test-arch',
                description: 'test-description',
                device: 'test-device',
                vendor: 'test-vendor',
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
    mockArtifactDownload.mockResolvedValue(undefined);
    mockHasRequiredArtifacts.mockResolvedValue(true);

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

  it('reports allowed built-in local model ids without accepting unknown ids', () => {
    expect(getAllowedModels()).toEqual([GEMMA4_E2B_MODEL_ID]);
    expect(isModelAllowed(GEMMA4_E2B_MODEL_ID)).toBe(true);
    expect(isModelAllowed('unknown/local-model')).toBe(false);
    expect(addAllowedModels([GEMMA4_E2B_MODEL_ID, 'unknown/local-model'])).toEqual({
      added: [GEMMA4_E2B_MODEL_ID],
      rejected: ['unknown/local-model'],
    });

    expect(() =>
      setModelChecksums(GEMMA4_E2B_MODEL_ID, {
        onnxSha256: 'deprecated',
      })
    ).not.toThrow();
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

  it('rejects explicit wasm requests instead of silently falling back', async () => {
    const backend = new LocalLlmBackend();

    await expect(
      backend.initialize({
        device: 'wasm',
        modelId: GEMMA4_E2B_MODEL_ID,
      })
    ).rejects.toThrow('does not support wasm');
  });

  it('maps transformers progress callbacks onto loading percentages', async () => {
    const progressUpdates: Array<{ progress: number; stage: string }> = [];
    mockFromPretrainedProcessor.mockImplementationOnce(async function (
      this: typeof mockAutoProcessor,
      _modelId: string,
      options: { progress_callback?: (progress: { loaded: number; total: number }) => void }
    ) {
      if (this !== mockAutoProcessor) {
        throw new TypeError('this is not a constructor');
      }
      options.progress_callback?.({
        loaded: 1,
        total: 4,
      });
      return callableProcessor;
    });

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
      onProgress: (progress) => {
        progressUpdates.push({
          progress: progress.progress,
          stage: progress.stage,
        });
      },
    });

    expect(progressUpdates).toContainEqual({
      progress: 25,
      stage: 'loading',
    });
    expect(progressUpdates.at(-1)).toEqual({
      progress: 100,
      stage: 'ready',
    });
  });

  it('purges stale HTML responses from the Transformers cache before loading', async () => {
    const staleRequest = new Request('https://cdn.example.test/model/config.json');
    const modelRequest = new Request('https://cdn.example.test/model/model.onnx');
    const deleteCachedRequest = vi.fn().mockResolvedValue(true);
    const cache = {
      delete: deleteCachedRequest,
      keys: vi.fn().mockResolvedValue([staleRequest, modelRequest]),
      match: vi.fn().mockImplementation(async (request: Request) => {
        if (request === staleRequest) {
          return new Response('<html>not a model</html>', {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          });
        }
        return new Response('model-bytes', {
          headers: {
            'content-type': 'application/octet-stream',
          },
        });
      }),
    } satisfies Partial<Cache>;
    const openCache = vi.fn().mockResolvedValue(cache);
    vi.stubGlobal('caches', {
      open: openCache,
    });

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    expect(openCache).toHaveBeenCalledWith('transformers-cache');
    expect(deleteCachedRequest).toHaveBeenCalledExactlyOnceWith(staleRequest);
  });

  it('tracks ready and uninitialized status across repeated initialize and dispose calls', async () => {
    const backend = new LocalLlmBackend();

    expect(backend.isReady()).toBe(false);
    expect(backend.getStatus()).toEqual({ state: 'uninitialized' });
    await expect(backend.generate([])).rejects.toThrow('Model not initialized');

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });
    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    expect(mockFromPretrainedProcessor).toHaveBeenCalledTimes(1);
    expect(backend.isReady()).toBe(true);
    expect(backend.getStatus()).toEqual({ device: 'webgpu', state: 'ready' });

    await backend.dispose();

    expect(backend.isReady()).toBe(false);
    expect(backend.getStatus()).toEqual({ state: 'uninitialized' });
  });

  it('disposes loaded Gemma models when the backend is disposed', async () => {
    const disposeModel = vi.fn().mockResolvedValue(undefined);
    mockFromPretrainedModel.mockResolvedValueOnce({
      dispose: disposeModel,
      generate: mockModelGenerate,
    });
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });
    await backend.dispose();

    expect(disposeModel).toHaveBeenCalledOnce();
    expect(backend.isReady()).toBe(false);
  });

  it('uses explicit progress percentages and done status from Transformers progress callbacks', async () => {
    const progressUpdates: Array<{ file?: string; progress: number; stage: string }> = [];
    mockFromPretrainedProcessor.mockImplementationOnce(async function (
      this: typeof mockAutoProcessor,
      _modelId: string,
      options: {
        progress_callback?: (progress: {
          file?: string;
          progress?: number;
          status?: string;
        }) => void;
      }
    ) {
      if (this !== mockAutoProcessor) {
        throw new TypeError('this is not a constructor');
      }
      options.progress_callback?.({
        file: 'processor.json',
        progress: 42,
      });
      options.progress_callback?.({
        status: 'done',
      });
      return callableProcessor;
    });
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
      onProgress: (progress) => {
        progressUpdates.push(progress);
      },
    });

    expect(progressUpdates).toContainEqual({
      file: 'processor.json',
      message: 'Loading processor.json',
      progress: 42,
      stage: 'loading',
    });
    expect(progressUpdates).toContainEqual({
      message: `Loading ${GEMMA4_E2B_MODEL_ID}`,
      progress: 100,
      stage: 'loading',
    });
  });

  it('reports device availability and WebGPU adapter metadata', async () => {
    expect(LocalLlmBackend.isDeviceAvailable('wasm')).toBe(true);
    expect(LocalLlmBackend.isDeviceAvailable('webgpu')).toBe(true);
    expect(LocalLlmBackend.getBestDevice()).toBe('webgpu');

    await expect(LocalLlmBackend.getWebGpuInfo()).resolves.toEqual({
      architecture: 'test-arch',
      description: 'test-description',
      device: 'test-device',
      maxBufferSize: 8_000_000_000,
      maxStorageBufferBindingSize: 8_000_000_000,
      vendor: 'test-vendor',
    });

    installNavigatorWebGpu(false);
    await expect(LocalLlmBackend.getWebGpuInfo()).resolves.toBeNull();

    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(LocalLlmBackend.getWebGpuInfo()).resolves.toBeNull();
  });

  it('delegates model download and downloaded checks to the browser artifact store', async () => {
    const abortController = new AbortController();
    const onProgress = vi.fn();

    await LocalLlmBackend.downloadModel(GEMMA4_E2B_MODEL_ID, {
      cacheDir: '/tmp/ignored',
      onProgress,
      signal: abortController.signal,
    });

    expect(mockArtifactDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: GEMMA4_E2B_MODEL_ID,
      }),
      onProgress,
      abortController.signal
    );
    await expect(LocalLlmBackend.downloadModel('unknown/local-model')).rejects.toThrow(
      'unsupported built-in local model'
    );
    await expect(LocalLlmBackend.hasDownloadedModel('unknown/local-model')).resolves.toBe(false);
    await expect(LocalLlmBackend.hasDownloadedModel(GEMMA4_E2B_MODEL_ID)).resolves.toBe(true);
    expect(mockHasRequiredArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: GEMMA4_E2B_MODEL_ID,
      })
    );
  });

  it('serializes concurrent generations on the single Gemma engine', async () => {
    // One engine, one WebGPU session: overlapping model.generate calls corrupt
    // the session (and interleave streamer state). The Mastra path can issue
    // chat + observational-memory generations close together, so the backend
    // must be the serialization chokepoint for every consumer.
    const backend = new LocalLlmBackend();
    await backend.initialize({ modelId: GEMMA4_E2B_MODEL_ID });

    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    mockModelGenerate.mockImplementation(function (
      this: { generate: typeof mockModelGenerate },
      inputs: { streamer?: { callback_function?: (text: string) => void } }
    ) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          inputs.streamer?.callback_function?.('Final answer');
          resolve({ slice: vi.fn().mockReturnValue('TOKENS') });
        });
      });
    });

    const first = backend.generate([{ content: 'one', role: 'user' }]);
    const second = backend.generate([{ content: 'two', role: 'user' }]);

    await vi.waitFor(() => {
      expect(mockModelGenerate).toHaveBeenCalledTimes(1);
    });
    releases[0]?.();
    await first;

    await vi.waitFor(() => {
      expect(mockModelGenerate).toHaveBeenCalledTimes(2);
    });
    releases[1]?.();
    await second;

    expect(maxActive).toBe(1);
  });

  it('rejects a queued generation when its signal aborts while waiting for the slot', async () => {
    const backend = new LocalLlmBackend();
    await backend.initialize({ modelId: GEMMA4_E2B_MODEL_ID });

    const releases: Array<() => void> = [];
    mockModelGenerate.mockImplementation(function (
      this: { generate: typeof mockModelGenerate },
      inputs: { streamer?: { callback_function?: (text: string) => void } }
    ) {
      return new Promise((resolve) => {
        releases.push(() => {
          inputs.streamer?.callback_function?.('Final answer');
          resolve({ slice: vi.fn().mockReturnValue('TOKENS') });
        });
      });
    });

    const abortController = new AbortController();
    const first = backend.generate([{ content: 'one', role: 'user' }]);
    const second = backend.generate([{ content: 'two', role: 'user' }], {
      signal: abortController.signal,
    });
    const observedSecond = second.then(
      () => 'resolved' as const,
      (error: unknown) => error
    );

    await vi.waitFor(() => {
      expect(mockModelGenerate).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    releases[0]?.();
    await first;

    const outcome = await observedSecond;
    expect(outcome).toBeInstanceOf(Error);
    // The aborted request must never have reached the engine.
    expect(mockModelGenerate).toHaveBeenCalledTimes(1);
  });

  it('waits for the in-flight generation before disposing the engine', async () => {
    // GPU-fault recovery (and re-initialize) call dispose() while another
    // consumer's generation can still be in flight — disposing the engine
    // mid-generate is exactly the overlap the generation queue exists to
    // prevent, so dispose must take a queue turn like generate does.
    const disposeModel = vi.fn().mockResolvedValue(undefined);
    mockFromPretrainedModel.mockResolvedValueOnce({
      dispose: disposeModel,
      generate: mockModelGenerate,
    });
    const backend = new LocalLlmBackend();
    await backend.initialize({ modelId: GEMMA4_E2B_MODEL_ID });

    const releases: Array<() => void> = [];
    mockModelGenerate.mockImplementation(function (
      this: { generate: typeof mockModelGenerate },
      inputs: { streamer?: { callback_function?: (text: string) => void } }
    ) {
      return new Promise((resolve) => {
        releases.push(() => {
          inputs.streamer?.callback_function?.('Final answer');
          resolve({ slice: vi.fn().mockReturnValue('TOKENS') });
        });
      });
    });

    const inFlight = backend.generate([{ content: 'one', role: 'user' }]);
    await vi.waitFor(() => {
      expect(mockModelGenerate).toHaveBeenCalledTimes(1);
    });

    const disposal = backend.dispose();
    // Give the (buggy) dispose a chance to run ahead of the generation.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposeModel).not.toHaveBeenCalled();

    releases[0]?.();
    await expect(inFlight).resolves.toMatchObject({ text: 'Final answer' });
    await disposal;
    expect(disposeModel).toHaveBeenCalledOnce();
    expect(backend.isReady()).toBe(false);
  });

  it('reports the prompt token count in generation failures', async () => {
    // WebGPU faults are prompt-size dependent and the practical per-device
    // ceiling is unknown — the visible failure must carry the measurement so
    // the limit can be calibrated from the chat error itself.
    const backend = new LocalLlmBackend();
    await backend.initialize({ modelId: GEMMA4_E2B_MODEL_ID });

    mockModelGenerate.mockRejectedValueOnce(
      new Error('operation does not support unaligned accesses')
    );

    await expect(backend.generate([{ content: 'hello', role: 'user' }])).rejects.toThrow(
      /operation does not support unaligned accesses \(prompt: \d+ tokens\)/
    );
  });

  it('does not decorate abort errors with prompt diagnostics', async () => {
    const backend = new LocalLlmBackend();
    await backend.initialize({ modelId: GEMMA4_E2B_MODEL_ID });

    mockModelGenerate.mockRejectedValueOnce(
      new DOMException('The operation was aborted.', 'AbortError')
    );

    await expect(backend.generate([{ content: 'hello', role: 'user' }])).rejects.toThrow(
      /^The operation was aborted\.$/
    );
  });

  it('strips Gemma thought traces from generated text', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ content: 'Hello', role: 'user' }], {
      thinking: {
        enabled: true,
      },
    });

    expect(result.text).toBe('Final answer');
    expect(result.reasoningText).toBe('internal reasoning');
    expect(mockProcessorApplyChatTemplate).toHaveBeenCalledWith(
      [
        {
          content: 'Hello',
          role: 'user',
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

    const result = await backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
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
    const result = await backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
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
    const result = await backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
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

  it('does not leak embedded reasoning channel markers into streamed answer snapshots', async () => {
    mockBatchDecode.mockReturnValue([
      'hi <|channel>thought\ninternal reasoning<channel|>Visible answer',
    ]);
    mockModelGenerate.mockImplementation(async function (
      this: { generate: typeof mockModelGenerate },
      inputs: { streamer?: { callback_function?: (text: string) => void } }
    ) {
      if (this.generate !== mockModelGenerate) {
        throw new TypeError('this is not a constructor');
      }
      inputs.streamer?.callback_function?.('hi <|channel>thought\ninternal reasoning');
      inputs.streamer?.callback_function?.('<channel|>Visible answer');
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
    const result = await backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
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

    expect(textSnapshots).toContain('hi');
    expect(textSnapshots.at(-1)).toBe('hi Visible answer');
    expect(reasoningSnapshots.at(-1)).toBe('internal reasoning');
    expect(result.text).toBe('hi Visible answer');
    expect(result.reasoningText).toBe('internal reasoning');
  });

  it('binds Transformers.js loaders and runtime methods to their owners', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await expect(
      backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
        tools: [
          {
            function: {
              description: 'Return a joke',
              name: 'tell_joke',
              parameters: {
                properties: {
                  topic: { type: 'string' },
                },
                required: ['topic'],
                type: 'object',
              },
            },
            type: 'function',
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
          content: 'Tell me a joke',
          role: 'user',
        },
      ],
      {
        add_generation_prompt: true,
        enable_thinking: true,
        tools: [
          {
            function: {
              description: 'Return a joke',
              name: 'tell_joke',
              parameters: {
                properties: {
                  topic: { type: 'string' },
                },
                required: ['topic'],
                type: 'object',
              },
            },
            type: 'function',
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
      backend.generate([{ content: 'Tell me another joke', role: 'user' }], {
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
      backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
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

  it('normalizes camelCase processor input ids before model generation', async () => {
    mockProcessorCall.mockResolvedValueOnce({
      inputIds: {
        dims: [1, 7],
      },
    });
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await expect(
      backend.generate([{ content: 'Use camelCase tensors', role: 'user' }])
    ).resolves.toMatchObject({
      finishReason: 'stop',
      text: 'Final answer',
    });

    expect(mockModelGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        inputIds: {
          dims: [1, 7],
        },
      })
    );
  });

  it('rejects processor outputs without tensor input ids', async () => {
    mockProcessorCall.mockResolvedValueOnce({
      input_ids: {
        shape: [1, 4],
      },
    });
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await expect(backend.generate([{ content: 'Bad tensor', role: 'user' }])).rejects.toThrow(
      'Gemma processor inputs are missing input_ids'
    );
  });

  it('passes explicit generation options to Transformers with snake_case keys', async () => {
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    await backend.generate([{ content: 'Tune generation', role: 'user' }], {
      doSample: true,
      maxNewTokens: 12,
      temperature: 0.25,
      topK: 8,
      topP: 0.5,
    });

    expect(mockModelGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        do_sample: true,
        max_new_tokens: 12,
        temperature: 0.25,
        top_k: 8,
        top_p: 0.5,
      })
    );
  });

  it('aborts generation before running the processor when the signal is already aborted', async () => {
    const abortController = new AbortController();
    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });
    abortController.abort();

    await expect(
      backend.generate([{ content: 'Stop', role: 'user' }], {
        signal: abortController.signal,
      })
    ).rejects.toThrow('The operation was aborted');
    expect(mockProcessorCall).not.toHaveBeenCalled();
  });

  it('parses Gemma tool calls into local tool results', async () => {
    mockBatchDecode.mockReturnValue([
      '<|tool_call|>call:tell_joke{topic: <|"|>penguins<|"|>}<tool_call|>',
    ]);

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
      tools: [
        {
          function: {
            description: 'Return a joke',
            name: 'tell_joke',
            parameters: {
              properties: {
                topic: { type: 'string' },
              },
              required: ['topic'],
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.text).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.function).toEqual({
      arguments: JSON.stringify({ topic: 'penguins' }),
      name: 'tell_joke',
    });
  });

  it('parses wrapped JSON tool calls with omitted arguments as empty objects', async () => {
    mockBatchDecode.mockReturnValue(['<tool_call>{"name":"refresh_index"}</tool_call>']);

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ content: 'Refresh the index', role: 'user' }], {
      tools: [
        {
          function: {
            description: 'Refresh the current index',
            name: 'refresh_index',
            parameters: {
              properties: {},
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0]?.function).toEqual({
      arguments: JSON.stringify({}),
      name: 'refresh_index',
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

    const result = await backend.generate([{ content: 'Tell me a joke', role: 'user' }], {
      tools: [
        {
          function: {
            description: 'Return a joke',
            name: 'tell_joke',
            parameters: {
              properties: {
                topic: { type: 'string' },
              },
              required: ['topic'],
              type: 'object',
            },
          },
          type: 'function',
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

    const result = await backend.generate([{ content: 'Read the readme', role: 'user' }], {
      tools: [
        {
          function: {
            description: 'Read a file',
            name: 'read_file',
            parameters: {
              properties: {
                options: {
                  properties: {
                    encoding: { type: 'string' },
                  },
                  type: 'object',
                },
                path: { type: 'string' },
              },
              required: ['path'],
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    });

    expect(result.finishReason).toBe('tool_calls');
    const toolCall = result.toolCalls?.[0]?.function;
    expect(toolCall?.name).toBe('read_file');
    expect(JSON.parse(toolCall?.arguments ?? '{}')).toEqual({
      options: {
        encoding: 'utf8',
      },
      path: '/README.md',
    });
  });

  it('parses Gemma tool call arguments with single-character keys', async () => {
    mockBatchDecode.mockReturnValue(['<|tool_call|>call:demo{x:1,y:<|"|>two<|"|>}<tool_call|>']);

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ content: 'Call the tool', role: 'user' }], {
      tools: [
        {
          function: {
            description: 'Demo tool',
            name: 'demo',
            parameters: {
              properties: {
                x: { type: 'number' },
                y: { type: 'string' },
              },
              required: ['x', 'y'],
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    });

    expect(result.toolCalls?.[0]?.function).toEqual({
      arguments: JSON.stringify({
        x: 1,
        y: 'two',
      }),
      name: 'demo',
    });
  });

  it('does not rewrite JSON-like substrings inside string argument values', async () => {
    mockBatchDecode.mockReturnValue([
      '<|tool_call|>call:demo{message:<|"|>literal {x:1} value<|"|>}<tool_call|>',
    ]);

    const backend = new LocalLlmBackend();

    await backend.initialize({
      modelId: GEMMA4_E2B_MODEL_ID,
    });

    const result = await backend.generate([{ content: 'Call the tool', role: 'user' }], {
      tools: [
        {
          function: {
            description: 'Demo tool',
            name: 'demo',
            parameters: {
              properties: {
                message: { type: 'string' },
              },
              required: ['message'],
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    });

    expect(result.toolCalls?.[0]?.function).toEqual({
      arguments: JSON.stringify({
        message: 'literal {x:1} value',
      }),
      name: 'demo',
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
            content: '',
            role: 'assistant',
            toolCalls: [
              {
                function: {
                  arguments: JSON.stringify({ path: '/README.md' }),
                  name: 'read_file',
                },
                id: 'tool-1',
                type: 'function',
              },
            ],
          },
          {
            content: '',
            role: 'tool',
            toolResponses: [
              {
                name: 'read_file',
                response: {
                  result: 'hello',
                  success: true,
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
              function: {
                arguments: {
                  path: '/README.md',
                },
                name: 'read_file',
              },
              type: 'function',
            },
          ],
        },
        {
          role: 'tool',
          tool_responses: [
            {
              name: 'read_file',
              response: {
                result: 'hello',
                success: true,
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

  it('throws an explicit disabled error when legacy integrity verification is invoked', async () => {
    await expect(verifyModelIntegrity(GEMMA4_E2B_MODEL_ID, new ArrayBuffer(8))).rejects.toThrow(
      'integrity_verification_disabled'
    );
  });
});
