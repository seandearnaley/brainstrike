/**
 * AI SDK v2 compatible language model wrapper for local LLM inference.
 *
 * Wraps the LocalLlmBackend to provide compatibility with Mastra's MastraModelConfig type.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import type { LocalProviderOptions } from '../../types';
import { LocalLlmBackend } from './local-llm-backend';
import {
  buildV2ContentFromResult,
  buildV2UsageFromResult,
  convertPromptToLocalMessages,
  convertToolsFromArray,
  generateStreamPartId,
  mapFinishReason,
  segmentTextForStream,
} from './local-message-conversion';
import type { LocalLlmToolDefinition } from './types';

interface LocalLanguageModelSettings {
  maxNewTokens?: number;
  temperature?: number;
  thinking?: LocalProviderOptions['thinking'];
  topK?: number;
  topP?: number;
}

/**
 * AI SDK v2 compatible language model for local inference
 */
export class LocalLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'local';
  readonly modelId: string;

  /**
   * Supported URL patterns by media type.
   * Local models don't natively support any URLs - all content must be provided directly.
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly backend: LocalLlmBackend;
  private readonly settings: LocalLanguageModelSettings;
  private initialized = false;

  constructor(modelId: string, settings: LocalLanguageModelSettings = {}) {
    this.modelId = modelId;
    this.settings = settings;
    this.backend = new LocalLlmBackend();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.backend.isReady()) {
      return;
    }

    await this.backend.initialize({
      modelId: this.modelId,
    });
    this.initialized = true;
  }

  doGenerate(
    options: LanguageModelV2CallOptions
  ): PromiseLike<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
    return this.executeGenerate(options);
  }

  private async executeGenerate(
    options: LanguageModelV2CallOptions
  ): Promise<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
    await this.ensureInitialized();

    const messages = convertPromptToLocalMessages(options.prompt);

    // Extract tools from options
    const tools = convertToolsFromArray(options.tools);

    // Build generation options conditionally to satisfy exactOptionalPropertyTypes
    const generateOptions: {
      maxNewTokens: number;
      temperature?: number;
      topP?: number;
      topK?: number;
      thinking?: {
        enabled?: boolean;
      };
      tools?: LocalLlmToolDefinition[];
      signal?: AbortSignal;
    } = {
      maxNewTokens: options.maxOutputTokens ?? this.settings.maxNewTokens ?? 512,
    };

    const temperature = options.temperature ?? this.settings.temperature;
    if (temperature !== undefined) {
      generateOptions.temperature = temperature;
    }

    const topP = options.topP ?? this.settings.topP;
    if (topP !== undefined) {
      generateOptions.topP = topP;
    }

    const topK = options.topK ?? this.settings.topK;
    if (topK !== undefined) {
      generateOptions.topK = topK;
    }

    if (tools !== undefined) {
      generateOptions.tools = tools;
    }

    if (this.settings.thinking !== undefined) {
      generateOptions.thinking = this.settings.thinking;
    }

    if (options.abortSignal !== undefined) {
      generateOptions.signal = options.abortSignal;
    }

    const result = await this.backend.generate(messages, generateOptions);

    // Build warnings array (required in V2)
    const warnings: LanguageModelV2CallWarning[] = [];

    return {
      content: buildV2ContentFromResult(result),
      finishReason: mapFinishReason(result.finishReason),
      usage: buildV2UsageFromResult(result),
      warnings,
      request: {
        body: {
          messages,
          maxNewTokens: generateOptions.maxNewTokens,
          temperature: generateOptions.temperature,
          topP: generateOptions.topP,
          topK: generateOptions.topK,
        },
      },
    };
  }

  doStream(
    options: LanguageModelV2CallOptions
  ): PromiseLike<Awaited<ReturnType<LanguageModelV2['doStream']>>> {
    return this.executeStream(options);
  }

  /**
   * Execute streaming generation.
   *
   * **LIMITATION**: This is NOT true token-by-token streaming.
   * The full response is generated first, then emitted as stream parts.
   * This means:
   * - Users will experience full generation latency upfront
   * - No incremental text updates during generation
   * - Memory usage reflects the complete response
   *
   * This limitation exists because:
   * 1. transformers.js doesn't expose token-by-token streaming callbacks
   * 2. The ONNX runtime generates the full sequence before returning
   *
   * True streaming will be implemented when transformers.js adds support.
   * For now, consider using doGenerate() directly for non-streaming use cases.
   */
  private async executeStream(
    options: LanguageModelV2CallOptions
  ): Promise<Awaited<ReturnType<LanguageModelV2['doStream']>>> {
    // SIMULATED STREAMING: Full generation first, then stream from memory
    // See method JSDoc for details on this limitation
    const result = await this.executeGenerate(options);

    const parts: LanguageModelV2StreamPart[] = [];

    // Emit stream-start with warnings
    parts.push({
      type: 'stream-start',
      warnings: result.warnings,
    });

    // Stream text content if present
    for (const item of result.content) {
      if (item.type === 'reasoning') {
        const reasoningId = generateStreamPartId();
        parts.push({ type: 'reasoning-start', id: reasoningId });
        for (const delta of segmentTextForStream(item.text)) {
          parts.push({ type: 'reasoning-delta', id: reasoningId, delta });
        }
        parts.push({ type: 'reasoning-end', id: reasoningId });
      } else if (item.type === 'text') {
        const textId = generateStreamPartId();
        parts.push({ type: 'text-start', id: textId });
        for (const delta of segmentTextForStream(item.text)) {
          parts.push({ type: 'text-delta', id: textId, delta });
        }
        parts.push({ type: 'text-end', id: textId });
      } else if (item.type === 'tool-call') {
        // For tool calls, we emit the complete tool call
        parts.push(item);
      }
    }

    // Add finish part
    parts.push({
      type: 'finish',
      usage: result.usage,
      finishReason: result.finishReason,
    });

    // Create a ReadableStream from the parts
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });

    // Build return object carefully to satisfy exactOptionalPropertyTypes
    const streamResult: Awaited<ReturnType<LanguageModelV2['doStream']>> = {
      stream,
    };

    // Only add request if it exists
    if (result.request !== undefined) {
      streamResult.request = result.request;
    }

    return streamResult;
  }
}

/**
 * Create a local language model instance
 */
export function createLocalLanguageModel(
  modelId: string,
  settings?: LocalLanguageModelSettings
): LanguageModelV2 {
  return new LocalLanguageModel(modelId, settings);
}
