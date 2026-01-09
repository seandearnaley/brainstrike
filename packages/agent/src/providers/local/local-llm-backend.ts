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
type ProgressInfo = {
  status: string;
  loaded?: number;
  total?: number;
  file?: string;
};

// Chat message for pipeline input
// Includes all standard chat roles - pipeline handles them appropriately
type ChatMessage = {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  content: string;
};

// Pipeline output for text generation
type TextGenerationOutput = {
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  generated_text: string | ChatMessage[];
};

// Text generation pipeline type
type TextGenerationPipeline = {
  (
    messages: ChatMessage[] | string,
    options?: {
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      max_new_tokens?: number;
      temperature?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      top_p?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      top_k?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      do_sample?: boolean;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      repetition_penalty?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      return_full_text?: boolean;
    }
  ): Promise<TextGenerationOutput[]>;
  dispose?: () => Promise<void>;
};

// Pipeline factory function type
type PipelineFunction = (
  task: 'text-generation',
  model: string,
  options?: {
    device?: string;
    dtype?: string;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    progress_callback?: (progress: ProgressInfo) => void;
  }
) => Promise<TextGenerationPipeline>;

type TransformersModule = {
  pipeline: PipelineFunction;
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
 * Download a file from HuggingFace Hub with streaming to avoid memory issues.
 * Uses TransformStream for progress tracking without buffering the entire file.
 * Stores directly in browser Cache API which transformers.js uses internally.
 *
 * Based on HuggingFace transformers.js GitHub issue #1041.
 */
async function downloadFileToCache(
  modelId: string,
  filePath: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const url = `https://huggingface.co/${modelId}/resolve/main/${filePath}`;

  // Check if already cached
  const cache = await caches.open('transformers-cache');
  const cachedResponse = await cache.match(url);
  if (cachedResponse) {
    logger.debug('File already cached', { modelId, filePath });
    onProgress?.(1, 1); // Report as complete
    return;
  }

  // Fetch with streaming
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: Failed to fetch ${filePath}`);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? Number.parseInt(contentLength, 10) : 0;

  if (!response.body) {
    throw new Error('Response body is null');
  }

  // Create a TransformStream for progress tracking without buffering
  // This pipes chunks through and reports progress without collecting in memory
  let loaded = 0;
  const progressTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.length;
      if (total > 0) {
        onProgress?.(loaded, total);
      }
      controller.enqueue(chunk);
    },
  });

  // Pipe through progress transform - this streams directly to cache
  const transformedStream = response.body.pipeThrough(progressTransform);

  // Store in cache with streaming response - no buffering required
  const cacheResponse = new Response(transformedStream, {
    headers: {
      'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Length': String(total),
    },
  });

  await cache.put(url, cacheResponse);

  logger.debug('File downloaded and cached', { modelId, filePath, size: loaded });
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
 * Parse LFM2.5 Pythonic format: <|tool_call_start|>[func_name(arg="value")]<|tool_call_end|>
 * LFM2.5 outputs tool calls as Python-style function calls wrapped in special tokens.
 *
 * Examples:
 * - <|tool_call_start|>[get_weather(location="Paris")]<|tool_call_end|>
 * - <|tool_call_start|>[search(query="AI news", limit=10)]<|tool_call_end|>
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parses multiple argument formats (strings, numbers, booleans)
function parseLfmFormat(output: string): LocalLlmToolCall | null {
  const match = output.match(/<\|tool_call_start\|>\s*\[(\w+)\(([^)]*)\)\]\s*<\|tool_call_end\|>/);
  if (!match) {
    return null;
  }

  const [, funcName, argsStr] = match;
  const args: Record<string, string | number | boolean> = {};

  if (argsStr) {
    // Parse Python-style kwargs: key="value", key=123, key=true
    const argPattern = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?)|(\w+))/g;
    for (const argMatch of argsStr.matchAll(argPattern)) {
      const key = argMatch[1];
      if (!key) {
        continue;
      }
      // Check which capture group matched
      if (argMatch[2] !== undefined) {
        args[key] = argMatch[2]; // double-quoted string
      } else if (argMatch[3] !== undefined) {
        args[key] = argMatch[3]; // single-quoted string
      } else if (argMatch[4] !== undefined) {
        args[key] = Number.parseFloat(argMatch[4]); // number
      } else if (argMatch[5] !== undefined) {
        // boolean or other identifier
        const val = argMatch[5].toLowerCase();
        if (val === 'true') {
          args[key] = true;
        } else if (val === 'false') {
          args[key] = false;
        } else {
          args[key] = argMatch[5];
        }
      }
    }
  }

  return {
    id: `call_${Date.now()}`,
    type: 'function',
    function: { name: funcName ?? '', arguments: JSON.stringify(args) },
  };
}

/**
 * Parse function call from model output
 * Supports multiple formats used by different models
 */
function parseFunctionCall(output: string): LocalLlmToolCall | null {
  return (
    parseLfmFormat(output) ??
    parseGemmaFormat(output) ??
    parseQwenFormat(output) ??
    parseGenericJsonFormat(output)
  );
}

/**
 * Models whose Jinja chat templates aren't supported by transformers.js's JS parser.
 * These need manual prompt formatting instead of relying on the chat template.
 *
 * The transformers.js Jinja parser doesn't support certain operators like
 * MultiplicativeBinaryOperator (array slicing with *), causing template errors.
 */
const MODELS_REQUIRING_MANUAL_FORMATTING = new Set(['onnx-community/functiongemma-270m-it-ONNX']);

/**
 * Model-specific dtype requirements.
 * Different models work best with different quantization formats.
 * Qwen models specifically require q4f16 (per their model card).
 */
type ModelDtype = 'q4' | 'q4f16' | 'fp16' | 'fp32';

const MODEL_DTYPE_MAP: Record<string, ModelDtype> = {
  // Qwen models require q4f16 per their model cards
  'onnx-community/Qwen3-0.6B-ONNX': 'q4f16',
  // NOTE: Qwen3-1.7B removed - crashes due to WebGPU buffer limits in ONNX Runtime
  // See: https://github.com/huggingface/transformers.js/issues/1469
  // LiquidAI works with standard q4
  'LiquidAI/LFM2.5-1.2B-Instruct-ONNX': 'q4',
  // FunctionGemma uses q4
  'onnx-community/functiongemma-270m-it-ONNX': 'q4',
};

/**
 * Get the recommended dtype for a model.
 * Returns q4f16 for Qwen models, q4 for others.
 */
function getModelDtype(modelId: string): ModelDtype {
  const mapped = MODEL_DTYPE_MAP[modelId];
  if (mapped) {
    return mapped;
  }
  // Default: Qwen models use q4f16, others use q4
  if (modelId.includes('Qwen')) {
    return 'q4f16';
  }
  return 'q4';
}

/**
 * Estimated model file sizes in bytes for memory planning.
 * These are approximate sizes based on model card info.
 */
const MODEL_SIZE_ESTIMATES: Record<string, number> = {
  'onnx-community/Qwen3-0.6B-ONNX': 570 * 1024 * 1024, // ~570MB
  // NOTE: Qwen3-1.7B removed - crashes due to WebGPU buffer limits in ONNX Runtime
  'LiquidAI/LFM2.5-1.2B-Instruct-ONNX': 800 * 1024 * 1024, // ~800MB
  'onnx-community/functiongemma-270m-it-ONNX': 200 * 1024 * 1024, // ~200MB
};

/**
 * Get estimated model size in bytes.
 */
function getEstimatedModelSize(modelId: string): number {
  return MODEL_SIZE_ESTIMATES[modelId] ?? 500 * 1024 * 1024; // Default 500MB
}

/**
 * Get the ONNX model file paths for a given dtype.
 */
function getModelFilesForDtype(dtype: ModelDtype): string[] {
  switch (dtype) {
    case 'q4f16':
      // q4f16 is self-contained, no external data file
      return ['onnx/model_q4f16.onnx'];
    case 'q4':
      // q4 may have external data file (optional)
      return ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'];
    case 'fp16':
      return ['onnx/model_fp16.onnx', 'onnx/model_fp16.onnx_data'];
    case 'fp32':
      return ['onnx/model.onnx', 'onnx/model.onnx_data'];
    default:
      return ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'];
  }
}

/**
 * Models that support tool/function calling.
 * Each model may have different formats for receiving and outputting tool calls.
 */
const MODELS_SUPPORTING_TOOLS = new Set([
  'LiquidAI/LFM2.5-1.2B-Instruct-ONNX', // LFM2.5 - excellent tool calling support
  'onnx-community/functiongemma-270m-it-ONNX', // FunctionGemma - specialized for function calling
  'onnx-community/Qwen3-0.6B-ONNX', // Qwen3 supports tool calling
  'onnx-community/Qwen3-1.7B-ONNX', // Qwen3 supports tool calling
]);

/**
 * Check if a model supports tool/function calling.
 */
function supportsToolCalling(modelId: string): boolean {
  return MODELS_SUPPORTING_TOOLS.has(modelId);
}

/**
 * Tool definition type (matches LocalLlmToolDefinition from types.ts)
 */
type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
};

/**
 * Format tools as a system prompt for FunctionGemma.
 * FunctionGemma expects tools in a developer message with specific format.
 */
function formatToolsForFunctionGemma(tools: ToolDefinition[]): string {
  const toolsJson = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));

  return `You are a helpful assistant with access to the following functions:

${JSON.stringify(toolsJson, null, 2)}

To use these functions, respond with:
<start_function_call>call:function_name{param1:value1, param2:value2}<end_function_call>

Only call a function when the user's request requires it. If no function is needed, respond normally.`;
}

/**
 * Format tools as a system prompt for Qwen models.
 * Qwen3 expects tools in a specific XML-like format.
 */
function formatToolsForQwen(tools: ToolDefinition[]): string {
  const toolDescriptions = tools
    .map((tool) => {
      const params = Object.entries(tool.function.parameters.properties)
        .map(
          ([name, prop]) => `  - ${name} (${prop.type}): ${prop.description ?? 'No description'}`
        )
        .join('\n');
      return `Function: ${tool.function.name}
Description: ${tool.function.description}
Parameters:
${params}`;
    })
    .join('\n\n');

  return `You are a helpful assistant with access to the following functions:

${toolDescriptions}

To call a function, use this format:
<tool_call>{"name": "function_name", "arguments": {"param1": "value1"}}</tool_call>

Only call a function when the user's request requires it. If no function is needed, respond normally.`;
}

/**
 * Format tools for LFM2.5 models.
 * LFM2.5 expects tools as a JSON array with "List of tools:" prefix in the system prompt.
 * Output format uses special tokens: <|tool_call_start|>[func(args)]<|tool_call_end|>
 */
function formatToolsForLfm(tools: ToolDefinition[]): string {
  const toolsJson = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));

  return `List of tools: ${JSON.stringify(toolsJson)}`;
}

/**
 * Inject tools into messages based on model type.
 * Returns new messages array with tool definitions prepended as system/developer message.
 */
function injectToolsIntoMessages(
  messages: LocalLlmMessage[],
  tools: ToolDefinition[] | undefined,
  modelId: string
): LocalLlmMessage[] {
  if (!tools || tools.length === 0) {
    return messages;
  }

  if (!supportsToolCalling(modelId)) {
    logger.debug('Model does not support tool calling, ignoring tools', { modelId });
    return messages;
  }

  // Format tools based on model type
  let toolSystemPrompt: string;
  let role: 'system' | 'developer';

  if (modelId.includes('LFM2') || modelId.includes('LiquidAI')) {
    toolSystemPrompt = formatToolsForLfm(tools);
    role = 'system';
  } else if (modelId.includes('functiongemma')) {
    toolSystemPrompt = formatToolsForFunctionGemma(tools);
    role = 'developer'; // FunctionGemma uses developer role
  } else if (modelId.includes('Qwen')) {
    toolSystemPrompt = formatToolsForQwen(tools);
    role = 'system';
  } else {
    // Generic format for other models
    toolSystemPrompt = formatToolsForQwen(tools);
    role = 'system';
  }

  // Check if there's already a system message
  const hasSystemMessage = messages.some((m) => m.role === 'system' || m.role === 'developer');

  if (hasSystemMessage) {
    // Append tools to existing system message
    return messages.map((msg) => {
      if (msg.role === 'system' || msg.role === 'developer') {
        return {
          ...msg,
          content: `${msg.content}\n\n${toolSystemPrompt}`,
        };
      }
      return msg;
    });
  }

  // Prepend new system/developer message with tools
  return [{ role, content: toolSystemPrompt }, ...messages];
}

/**
 * Check if a model requires manual prompt formatting instead of using its chat template.
 */
function requiresManualPromptFormatting(modelId: string): boolean {
  return MODELS_REQUIRING_MANUAL_FORMATTING.has(modelId);
}

/**
 * Backend class for local LLM inference using pipeline API.
 * Uses transformers.js pipeline which handles tokenization internally,
 * avoiding issues with custom tokenizer classes.
 */
export class LocalLlmBackend {
  private pipeline: TextGenerationPipeline | null = null;
  private modelId: string | null = null;
  private selectedDevice: 'webgpu' | 'wasm' | null = null;
  private status: LocalLlmProviderStatus = { state: 'uninitialized' };

  /**
   * Initialize the backend with model configuration
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Initialization handles multiple device types and error cases
  async initialize(config: LocalLlmConfig): Promise<void> {
    if (this.pipeline && this.modelId === config.modelId) {
      return; // Already initialized with same model
    }

    // Dispose existing pipeline if switching
    if (this.pipeline) {
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
      // Use model-specific dtype - Qwen models need q4f16, others use q4
      // Must match downloadModel() which pre-caches the correct files
      const dtype = getModelDtype(config.modelId);

      // Get GPU info for diagnostics
      const gpuInfo = await LocalLlmBackend.getWebGpuInfo();
      const estimatedModelSize = getEstimatedModelSize(config.modelId);

      // Log GPU info separately for visibility (console may not expand nested objects)
      if (gpuInfo) {
        logger.info(
          `GPU detected: ${gpuInfo.vendor} ${gpuInfo.device}, maxBuffer=${Math.round(gpuInfo.maxBufferSize / (1024 * 1024))}MB`
        );
      } else {
        logger.warn('No WebGPU adapter available - will use WASM fallback');
      }

      logger.info(
        `Initializing LLM: model=${config.modelId}, device=${this.selectedDevice}, dtype=${dtype}, modelSize=${Math.round(estimatedModelSize / (1024 * 1024))}MB`
      );

      // Check if model might be too large for GPU buffers
      if (gpuInfo && this.selectedDevice === 'webgpu') {
        const modelSizeWithOverhead = estimatedModelSize * 1.5; // Add 50% overhead for runtime allocations
        if (modelSizeWithOverhead > gpuInfo.maxBufferSize) {
          logger.warn('Model may exceed WebGPU buffer limits', {
            modelId: config.modelId,
            estimatedModelSizeMB: Math.round(estimatedModelSize / (1024 * 1024)),
            modelSizeWithOverheadMB: Math.round(modelSizeWithOverhead / (1024 * 1024)),
            maxBufferSizeMB: Math.round(gpuInfo.maxBufferSize / (1024 * 1024)),
            gpuDevice: gpuInfo.device,
          });
        }
      }

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

      // Load using pipeline API - handles tokenization internally
      // This avoids issues with custom tokenizer classes like "TokenizersBackend"
      logger.info('Loading local LLM', { modelId: config.modelId, device: this.selectedDevice });

      this.pipeline = await transformers.pipeline('text-generation', config.modelId, {
        device: this.selectedDevice,
        dtype,
        // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
        progress_callback: progressCallback,
      });

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
      const message = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const stack = error instanceof Error ? error.stack : undefined;

      this.status = { state: 'error', error: message };

      // Log detailed error info for debugging
      logger.error('Failed to load local LLM', {
        modelId: config.modelId,
        device: this.selectedDevice,
        errorName,
        errorMessage: message,
        stack,
        // Check if this is a WASM abort (often memory-related)
        isAbort: message.includes('Aborted') || message === 'Aborted()',
      });

      throw error;
    }
  }

  /**
   * Format messages for Gemma-based models (including FunctionGemma).
   * Uses Gemma's special tokens: <start_of_turn>, <end_of_turn>, and role names.
   *
   * Format: <start_of_turn>role\ncontent<end_of_turn>
   * - user messages use "user" role
   * - assistant messages use "model" role (Gemma convention)
   * - developer/system messages use "developer" role (FunctionGemma specific)
   */
  private formatMessagesForGemma(messages: LocalLlmMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      let role: string;
      switch (msg.role) {
        case 'system':
        case 'developer':
          role = 'developer';
          break;
        case 'user':
          role = 'user';
          break;
        case 'assistant':
          role = 'model'; // Gemma uses "model" not "assistant"
          break;
        case 'tool':
          role = 'tool';
          break;
        default:
          role = 'user';
      }
      parts.push(`<start_of_turn>${role}\n${msg.content}<end_of_turn>`);
    }

    // Add start of model turn for response
    parts.push('<start_of_turn>model\n');

    return parts.join('\n');
  }

  /**
   * Format messages into a raw prompt string for the specific model.
   * Different models require different prompt formats.
   */
  private formatMessagesAsPrompt(messages: LocalLlmMessage[]): string {
    // FunctionGemma uses Gemma's chat format with special tokens
    if (this.modelId?.includes('functiongemma')) {
      return this.formatMessagesForGemma(messages);
    }

    // Default format for other models
    const parts: string[] = [];
    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
        case 'developer':
          parts.push(`System: ${msg.content}`);
          break;
        case 'user':
          parts.push(`User: ${msg.content}`);
          break;
        case 'assistant':
          parts.push(`Assistant: ${msg.content}`);
          break;
        case 'tool':
          parts.push(`Tool: ${msg.content}`);
          break;
        default:
          parts.push(msg.content);
      }
    }
    parts.push('Assistant:');
    return parts.join('\n\n');
  }

  /**
   * Generate text from messages using the pipeline API.
   * The pipeline handles tokenization internally, avoiding issues
   * with custom tokenizer classes.
   *
   * Models with unsupported Jinja templates are detected upfront and
   * use manual prompt formatting directly (no runtime fallback).
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Generation handles tool injection, output parsing, and multiple formats
  async generate(
    messages: LocalLlmMessage[],
    options: LocalLlmGenerationOptions = {}
  ): Promise<LocalLlmGenerationResult> {
    if (!this.pipeline) {
      throw new Error('Model not initialized. Call initialize() first.');
    }

    if (!this.modelId) {
      throw new Error('Model ID not set. Initialize the model first.');
    }

    // Check for abort
    if (options.signal?.aborted) {
      throw new DOMException('Generation aborted', 'AbortError');
    }

    // Inject tools into messages if provided
    const messagesWithTools = injectToolsIntoMessages(messages, options.tools, this.modelId);

    // Build generation options for pipeline
    const generateOptions: Parameters<TextGenerationPipeline>[1] = {
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      max_new_tokens: options.maxNewTokens ?? 512,
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      do_sample: options.doSample ?? (options.temperature !== undefined && options.temperature > 0),
      // Only return the new text, not the full conversation
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      return_full_text: false,
    };

    // Add optional generation parameters
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

    let output: TextGenerationOutput[];

    // Models with unsupported Jinja templates need manual prompt formatting.
    // This is determined upfront based on the model ID, not via runtime fallback.
    if (requiresManualPromptFormatting(this.modelId)) {
      logger.debug('Using manual prompt formatting for model', { modelId: this.modelId });
      const rawPrompt = this.formatMessagesAsPrompt(messagesWithTools);
      output = await this.pipeline(rawPrompt, generateOptions);
    } else {
      // Convert messages to chat format expected by pipeline
      const chatMessages: ChatMessage[] = messagesWithTools.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
      output = await this.pipeline(chatMessages, generateOptions);
    }

    // Extract generated text from output
    // Pipeline returns array of { generated_text: string | ChatMessage[] }
    const firstOutput = output[0];
    let generatedText = '';

    if (firstOutput) {
      const generated = firstOutput.generated_text;
      if (typeof generated === 'string') {
        generatedText = generated;
      } else if (Array.isArray(generated)) {
        // If it returns chat messages, get the last assistant message
        const lastMessage = generated.at(-1);
        if (lastMessage?.role === 'assistant') {
          generatedText = lastMessage.content;
        }
      }
    }

    // Parse for tool calls
    const toolCall = parseFunctionCall(generatedText);

    // Build result - pipeline doesn't expose token counts directly
    const result: LocalLlmGenerationResult = {
      text: generatedText,
      finishReason: toolCall ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: 0, // Pipeline doesn't expose this
        completionTokens: 0, // Pipeline doesn't expose this
        totalTokens: 0,
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
   * Dispose of loaded pipeline
   */
  async dispose(): Promise<void> {
    if (this.pipeline?.dispose) {
      try {
        await this.pipeline.dispose();
      } catch (error) {
        logger.debug('Error disposing pipeline', { error });
      }
    }
    this.pipeline = null;
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
   * Get WebGPU adapter information for diagnostics.
   * Returns null if WebGPU is not available or adapter request fails.
   */
  static async getWebGpuInfo(): Promise<{
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
  } | null> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      return null;
    }

    try {
      // WebGPU types aren't fully available in all TypeScript configs
      // Cast through unknown to access the API
      const gpu = navigator.gpu as unknown as {
        requestAdapter(): Promise<{
          info: {
            vendor: string;
            architecture: string;
            device: string;
            description: string;
          };
          limits: {
            maxBufferSize: number;
            maxStorageBufferBindingSize: number;
          };
        } | null>;
      };

      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        logger.warn('WebGPU adapter request returned null - no compatible GPU found');
        return null;
      }

      const info = adapter.info;
      const limits = adapter.limits;

      return {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        maxBufferSize: limits.maxBufferSize,
        maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      };
    } catch (error) {
      logger.warn('Failed to get WebGPU adapter info', { error });
      return null;
    }
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
   * Uses fetch streaming + Cache API to download files without loading into memory.
   * Based on HuggingFace transformers.js GitHub issue #1041.
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
    // Note: cacheDir option is ignored for browser Cache API storage
    // The Cache API uses the HuggingFace CDN URL as the cache key

    logger.info('Downloading LLM model files to cache', { modelId });

    // Files needed for LLM inference - download each individually to cache
    // This avoids loading them into memory (unlike from_pretrained)
    const tokenizerFiles = ['tokenizer.json', 'tokenizer_config.json'];

    const configFiles = ['config.json', 'generation_config.json', 'chat_template.jinja'];

    // ONNX model files - use model-specific dtype
    // Qwen models use q4f16 (per their model cards), others use q4
    const dtype = getModelDtype(modelId);
    const modelFiles = getModelFilesForDtype(dtype);
    logger.info('Using dtype for model download', { modelId, dtype, modelFiles });

    const allFiles = [...tokenizerFiles, ...configFiles, ...modelFiles];
    let completedFiles = 0;

    type DownloadProgressData = {
      stage: 'downloading' | 'ready';
      progress: number;
      message: string;
      file?: string;
    };

    const updateProgress = (filename: string, fileProgress?: number) => {
      // If we have file-level progress, use it; otherwise use completed file count
      const overallProgress =
        fileProgress !== undefined
          ? Math.round(((completedFiles + fileProgress / 100) / allFiles.length) * 100)
          : Math.round((completedFiles / allFiles.length) * 100);

      const progressData: DownloadProgressData = {
        stage: 'downloading',
        progress: overallProgress,
        message: `Downloading ${filename}...`,
        file: filename,
      };
      options?.onProgress?.(progressData);
    };

    // Download files sequentially to avoid memory pressure
    for (const filename of allFiles) {
      updateProgress(filename, 0);

      try {
        // Create per-file progress callback
        const fileProgressCallback = (loaded: number, total: number) => {
          if (total > 0) {
            const pct = Math.round((loaded / total) * 100);
            updateProgress(filename, pct);
          }
        };

        // Download file to cache using streaming fetch
        await downloadFileToCache(modelId, filename, fileProgressCallback);

        completedFiles++;
        logger.debug('Downloaded file', { modelId, filename });
      } catch (error) {
        // Some files are optional (e.g., onnx_data for smaller models, config files)
        const isOptional =
          filename.endsWith('_data') ||
          filename === 'generation_config.json' ||
          filename === 'chat_template.jinja';
        if (isOptional) {
          logger.debug('Optional file not found, skipping', { modelId, filename });
          completedFiles++;
        } else {
          logger.error('Failed to download required file', { modelId, filename, error });
          throw error;
        }
      }
    }

    options?.onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Model downloaded',
    });

    logger.info('LLM model download complete', {
      modelId,
      dtype,
      filesDownloaded: allFiles.length,
    });
  }
}
