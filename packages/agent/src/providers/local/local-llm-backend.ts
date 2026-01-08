/**
 * Backend for local LLM inference using transformers.js
 *
 * Supports text generation with tool/function calling via ONNX models.
 */
import { createLogger } from '@brainstrike/utils';
import type {
  LocalLlmConfig,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
  LocalLlmProviderStatus,
  LocalLlmToolCall,
} from './types';

const logger = createLogger('LocalLlmBackend');

// Transformers.js types (dynamically imported)
type TransformersModule = {
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  AutoModelForCausalLM: {
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    from_pretrained: (
      modelId: string,
      options?: {
        device?: string;
        dtype?: string;
        // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
        progress_callback?: (progress: ProgressInfo) => void;
      }
    ) => Promise<CausalLmModel>;
  };
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  AutoTokenizer: {
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    from_pretrained: (modelId: string) => Promise<Tokenizer>;
  };
};

type ProgressInfo = {
  status: string;
  loaded?: number;
  total?: number;
  file?: string;
};

type Tokenizer = {
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  apply_chat_template: (
    messages: LocalLlmMessage[],
    options: {
      tools?: unknown[] | undefined;
      tokenize: boolean;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      add_generation_prompt: boolean;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      return_dict: boolean;
    }
  ) => TokenizedInput;
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  decode: (tokens: bigint[] | BigInt64Array, options?: { skip_special_tokens?: boolean }) => string;
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  model_max_length?: number;
};

type TokenizedInput = {
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  input_ids: {
    dims: number[];
    data: bigint[];
    slice: (start: number, end: (number | null)[]) => bigint[];
  };
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  attention_mask?: { dims: number[]; data: bigint[] } | undefined;
};

type CausalLmModel = {
  generate: (options: {
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    input_ids?: { dims: number[]; data: bigint[] } | undefined;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    attention_mask?: { dims: number[]; data: bigint[] } | undefined;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    max_new_tokens?: number | undefined;
    temperature?: number | undefined;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    top_p?: number | undefined;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    top_k?: number | undefined;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    do_sample?: boolean | undefined;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    repetition_penalty?: number | undefined;
  }) => Promise<bigint[] | BigInt64Array>;
  dispose?: () => Promise<void>;
};

// Module-level cache for transformers.js
let transformersModule: TransformersModule | null = null;
let transformersModulePromise: Promise<TransformersModule> | null = null;

async function getTransformersModule(): Promise<TransformersModule> {
  if (transformersModule) {
    return transformersModule;
  }
  if (!transformersModulePromise) {
    // Cast through unknown because transformers.js types are more general than our specific subset
    transformersModulePromise = import('@huggingface/transformers').then(
      (mod) => mod as unknown as TransformersModule
    );
  }
  transformersModule = await transformersModulePromise;
  return transformersModule;
}

/**
 * Parse FunctionGemma format: <start_function_call>call:name{args}<end_function_call>
 */
function parseGemmaFormat(output: string): LocalLlmToolCall | null {
  const match = output.match(/<start_function_call>call:(\w+)\{([^}]*)\}<end_function_call>/);
  if (!match) {
    return null;
  }

  const [, name, argsStr] = match;
  const args: Record<string, string> = {};
  if (argsStr) {
    for (const pair of argsStr.split(',')) {
      const [key, value] = pair.split(':');
      if (key && value) {
        args[key.trim()] = value.replace(/<escape>/g, '').trim();
      }
    }
  }
  return {
    id: `call_${Date.now()}`,
    type: 'function',
    function: { name: name ?? '', arguments: JSON.stringify(args) },
  };
}

/**
 * Parse Qwen format: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 */
function parseQwenFormat(output: string): LocalLlmToolCall | null {
  const match = output.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!match) {
    return null;
  }

  const jsonContent = match[1];
  if (!jsonContent) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonContent) as {
      name: string;
      arguments: Record<string, unknown>;
    };
    return {
      id: `call_${Date.now()}`,
      type: 'function',
      function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) },
    };
  } catch {
    logger.debug('Failed to parse Qwen tool call JSON', { raw: jsonContent });
    return null;
  }
}

/**
 * Parse generic JSON format: {"name": "...", "arguments": {...}}
 */
function parseGenericJsonFormat(output: string): LocalLlmToolCall | null {
  const match = output.match(/\{"name":\s*"(\w+)",\s*"arguments":\s*(\{[^}]+\})\}/);
  if (!match) {
    return null;
  }

  const [, name, argsJson] = match;
  return {
    id: `call_${Date.now()}`,
    type: 'function',
    function: { name: name ?? '', arguments: argsJson ?? '{}' },
  };
}

/**
 * Parse function call from model output
 * Supports multiple formats used by different models
 */
function parseFunctionCall(output: string): LocalLlmToolCall | null {
  return parseGemmaFormat(output) ?? parseQwenFormat(output) ?? parseGenericJsonFormat(output);
}

/**
 * Backend class for local LLM inference
 */
export class LocalLlmBackend {
  private model: CausalLmModel | null = null;
  private tokenizer: Tokenizer | null = null;
  private modelId: string | null = null;
  private selectedDevice: 'webgpu' | 'wasm' | null = null;
  private status: LocalLlmProviderStatus = { state: 'uninitialized' };

  /**
   * Initialize the backend with model configuration
   */
  async initialize(config: LocalLlmConfig): Promise<void> {
    if (this.model && this.tokenizer && this.modelId === config.modelId) {
      return; // Already initialized with same model
    }

    // Dispose existing model if switching
    if (this.model) {
      await this.dispose();
    }

    this.status = { state: 'loading', progress: 0, message: 'Loading model...' };
    config.onProgress?.({
      stage: 'downloading',
      progress: 0,
      message: `Loading ${config.modelId}...`,
    });

    try {
      const transformers = await getTransformersModule();

      // Determine device
      this.selectedDevice = this.determineDevice(config.device);
      // Use fp16 for both WebGPU and WASM - q4 dtype mapping is unreliable
      // (transformers.js looks for model_quantized.onnx instead of model_q4.onnx)
      const dtype = 'fp16';

      // Create progress callback
      const progressCallback = (progress: ProgressInfo) => {
        if (progress.status === 'progress' && progress.total) {
          const pct = Math.round(((progress.loaded ?? 0) / progress.total) * 100);
          this.status = {
            state: 'loading',
            progress: pct,
            message: `Downloading ${progress.file ?? 'model'}...`,
          };
          // Build progress object conditionally to satisfy exactOptionalPropertyTypes
          const progressData: Parameters<NonNullable<LocalLlmConfig['onProgress']>>[0] = {
            stage: 'downloading',
            progress: pct,
            message: `Downloading ${progress.file ?? 'model'}...`,
          };
          if (progress.file !== undefined) {
            progressData.file = progress.file;
          }
          config.onProgress?.(progressData);
        }
      };

      // Load tokenizer and model in parallel
      logger.info('Loading local LLM', { modelId: config.modelId, device: this.selectedDevice });

      const [tokenizer, model] = await Promise.all([
        transformers.AutoTokenizer.from_pretrained(config.modelId),
        transformers.AutoModelForCausalLM.from_pretrained(config.modelId, {
          device: this.selectedDevice,
          dtype,
          // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
          progress_callback: progressCallback,
        }),
      ]);

      this.tokenizer = tokenizer;
      this.model = model;
      this.modelId = config.modelId;

      this.status = { state: 'ready', device: this.selectedDevice };
      config.onProgress?.({
        stage: 'ready',
        progress: 100,
        message: 'Model loaded',
      });

      logger.info('Local LLM loaded successfully', {
        modelId: config.modelId,
        device: this.selectedDevice,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.status = { state: 'error', error: message };
      logger.error('Failed to load local LLM', { modelId: config.modelId, error });
      throw error;
    }
  }

  /**
   * Generate text from messages
   */
  async generate(
    messages: LocalLlmMessage[],
    options: LocalLlmGenerationOptions = {}
  ): Promise<LocalLlmGenerationResult> {
    if (!(this.model && this.tokenizer)) {
      throw new Error('Model not initialized. Call initialize() first.');
    }

    // Check for abort
    if (options.signal?.aborted) {
      throw new DOMException('Generation aborted', 'AbortError');
    }

    // Apply chat template with tools
    const inputs = this.tokenizer.apply_chat_template(messages, {
      tools: options.tools,
      tokenize: true,
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      add_generation_prompt: true,
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      return_dict: true,
    });

    const promptTokens = inputs.input_ids.dims[1] ?? 0;

    // Build generate options conditionally for exactOptionalPropertyTypes
    const generateOptions: Parameters<CausalLmModel['generate']>[0] = {
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      input_ids: inputs.input_ids,
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      max_new_tokens: options.maxNewTokens ?? 512,
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      do_sample: options.doSample ?? (options.temperature !== undefined && options.temperature > 0),
    };

    // Only include optional properties if they have values
    if (inputs.attention_mask !== undefined) {
      generateOptions.attention_mask = inputs.attention_mask;
    }
    if (options.temperature !== undefined) {
      generateOptions.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      generateOptions.top_p = options.topP;
    }
    if (options.topK !== undefined) {
      generateOptions.top_k = options.topK;
    }
    if (options.repetitionPenalty !== undefined) {
      generateOptions.repetition_penalty = options.repetitionPenalty;
    }

    // Generate
    const output = await this.model.generate(generateOptions);

    // Decode only the generated tokens (skip input)
    const outputTokens = inputs.input_ids.slice(0, [promptTokens, null]);
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    const generatedText = this.tokenizer.decode(outputTokens, { skip_special_tokens: false });

    // Parse for tool calls
    const toolCall = parseFunctionCall(generatedText);

    // Clean the text (remove special tokens for display)
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    const cleanText = this.tokenizer.decode(output, { skip_special_tokens: true });

    // Compute token counts
    const totalTokens = Array.isArray(output) ? output.length : output.length;
    const completionTokens = totalTokens - promptTokens;

    // Build result conditionally for exactOptionalPropertyTypes
    const result: LocalLlmGenerationResult = {
      text: cleanText,
      finishReason: toolCall ? 'tool_calls' : 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
    };

    if (toolCall) {
      result.toolCalls = [toolCall];
    }

    return result;
  }

  /**
   * Get current status
   */
  getStatus(): LocalLlmProviderStatus {
    return this.status;
  }

  /**
   * Check if model is ready
   */
  isReady(): boolean {
    return this.status.state === 'ready';
  }

  /**
   * Get loaded model ID
   */
  getModelId(): string | null {
    return this.modelId;
  }

  /**
   * Dispose of loaded model
   */
  async dispose(): Promise<void> {
    if (this.model?.dispose) {
      try {
        await this.model.dispose();
      } catch (error) {
        logger.debug('Error disposing model', { error });
      }
    }
    this.model = null;
    this.tokenizer = null;
    this.modelId = null;
    this.selectedDevice = null;
    this.status = { state: 'uninitialized' };
  }

  /**
   * Determine best device for inference
   */
  private determineDevice(requested?: 'webgpu' | 'wasm'): 'webgpu' | 'wasm' {
    if (requested === 'webgpu') {
      if (!LocalLlmBackend.isDeviceAvailable('webgpu')) {
        throw new Error(
          'WebGPU requested but not available. Use wasm or check browser compatibility.'
        );
      }
      return 'webgpu';
    }

    if (requested === 'wasm') {
      return 'wasm';
    }

    // Auto-detect: prefer WebGPU
    if (LocalLlmBackend.isDeviceAvailable('webgpu')) {
      return 'webgpu';
    }

    return 'wasm';
  }

  /**
   * Check device availability
   */
  static isDeviceAvailable(device: 'webgpu' | 'wasm'): boolean {
    if (device === 'webgpu') {
      return typeof navigator !== 'undefined' && 'gpu' in navigator;
    }
    return typeof WebAssembly !== 'undefined';
  }

  /**
   * Get best available device
   */
  static getBestDevice(): 'webgpu' | 'wasm' {
    if (LocalLlmBackend.isDeviceAvailable('webgpu')) {
      return 'webgpu';
    }
    return 'wasm';
  }

  /**
   * Download an LLM model to cache without initializing for inference.
   * Uses AutoModelForCausalLM and AutoTokenizer from transformers.js.
   */
  static async downloadModel(
    modelId: string,
    options?: {
      cacheDir?: string;
      onProgress?: (progress: {
        stage: 'downloading' | 'ready';
        progress: number;
        message: string;
        file?: string;
      }) => void;
    }
  ): Promise<void> {
    const transformers = await getTransformersModule();

    // Set cache dir if provided
    if (options?.cacheDir) {
      const transformersEnv = transformers as unknown as {
        env?: { cacheDir?: string; allowLocalModels?: boolean };
      };
      if (transformersEnv.env) {
        transformersEnv.env.cacheDir = options.cacheDir;
        transformersEnv.env.allowLocalModels = false;
      }
    }

    type DownloadProgressData = {
      stage: 'downloading' | 'ready';
      progress: number;
      message: string;
      file?: string;
    };

    const progressCallback = (progress: ProgressInfo) => {
      // transformers.js uses 'progress' status for download progress
      if (progress.status === 'progress' && progress.total) {
        const pct = Math.round(((progress.loaded ?? 0) / progress.total) * 100);
        const progressData: DownloadProgressData = {
          stage: 'downloading',
          progress: pct,
          message: `Downloading ${progress.file ?? 'model'}... ${pct}%`,
        };
        if (progress.file !== undefined) {
          progressData.file = progress.file;
        }
        options?.onProgress?.(progressData);
      }
    };

    // Download both tokenizer and model files
    logger.info('Downloading LLM model', { modelId });

    await Promise.all([
      transformers.AutoTokenizer.from_pretrained(modelId),
      transformers.AutoModelForCausalLM.from_pretrained(modelId, {
        device: 'wasm', // Use WASM for download - less memory, just caching files
        dtype: 'fp16',
        // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
        progress_callback: progressCallback,
      }),
    ]);

    options?.onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Model downloaded',
    });

    logger.info('LLM model download complete', { modelId });
  }
}
