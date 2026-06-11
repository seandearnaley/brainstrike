/**
 * AI SDK v2 compatible language model wrapper for local LLM inference.
 *
 * Wraps the LocalLlmBackend to provide compatibility with Mastra's MastraModelConfig type.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
  LanguageModelV2Text,
  LanguageModelV2ToolCall,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import { generateUUID } from '@brainstrike/utils';
import type { LocalProviderOptions } from '../../types';
import { LocalLlmBackend } from './local-llm-backend';
import type { LocalLlmMessage, LocalLlmToolDefinition } from './types';

interface LocalLanguageModelSettings {
  maxNewTokens?: number;
  temperature?: number;
  thinking?: LocalProviderOptions['thinking'];
  topK?: number;
  topP?: number;
}

interface TextPart {
  text: string;
  type: 'text';
}

/**
 * Extract text from content array parts
 */
function extractTextFromParts(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const textParts = content
    .filter((part): part is TextPart => part?.type === 'text')
    .map((part) => part.text);
  return textParts.length > 0 ? textParts.join('\n') : null;
}

/**
 * Parse a tool result message
 */
function parseToolResultMessage(content: unknown): LocalLlmMessage[] {
  const results: LocalLlmMessage[] = [];
  if (!Array.isArray(content)) {
    return results;
  }

  for (const part of content) {
    if (part?.type !== 'tool-result') {
      continue;
    }
    const toolMsg: LocalLlmMessage = {
      role: 'tool',
      content: '',
    };
    if (typeof part.toolCallId === 'string') {
      toolMsg.toolCallId = part.toolCallId;
    }
    if (typeof part.toolName === 'string' && part.toolName.trim().length > 0) {
      toolMsg.toolResponses = [
        {
          name: part.toolName,
          response: part.result,
        },
      ];
    } else {
      toolMsg.content = typeof part.result === 'string' ? part.result : JSON.stringify(part.result);
    }
    results.push(toolMsg);
  }
  return results;
}

/**
 * Convert AI SDK v2 messages to LocalLlmMessage format
 */
function convertMessages(prompt: LanguageModelV2CallOptions['prompt']): LocalLlmMessage[] {
  const result: LocalLlmMessage[] = [];

  if (!Array.isArray(prompt)) {
    return result;
  }

  for (const msg of prompt) {
    // Explicit null/undefined check for clarity
    if (msg === null || msg === undefined) {
      continue;
    }

    if (typeof msg !== 'object') {
      continue;
    }

    // TypeScript now knows msg is a non-null object
    switch (msg.role) {
      case 'system':
        if (typeof msg.content === 'string') {
          result.push({ role: 'system', content: msg.content });
        }
        break;
      case 'user': {
        const text = extractTextFromParts(msg.content);
        if (text) {
          result.push({ role: 'user', content: text });
        }
        break;
      }
      case 'assistant': {
        const text = extractTextFromParts(msg.content);
        if (text) {
          result.push({ role: 'assistant', content: text });
        }
        break;
      }
      case 'tool':
        result.push(...parseToolResultMessage(msg.content));
        break;
    }
  }

  return result;
}

/**
 * Convert AI SDK v2 tool array to LocalLlmToolDefinition format
 */
function convertToolsFromArray(
  tools?: LanguageModelV2CallOptions['tools']
): LocalLlmToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return;
  }

  return tools
    .filter((tool): tool is LanguageModelV2FunctionTool => tool.type === 'function')
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema as LocalLlmToolDefinition['function']['parameters'],
      },
    }));
}

/**
 * Map finish reason to AI SDK v2 format
 */
function mapFinishReason(reason: 'stop' | 'length' | 'tool_calls'): LanguageModelV2FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool-calls';
    default:
      return 'stop';
  }
}

/**
 * Generate a unique ID for stream parts
 */
function generateId(): string {
  // Preserve compact 9-char IDs for stream consumers; this intentionally narrows to hex ([0-9a-f], ~36-bit space) and accepts minor UUID-generation overhead for low-volume stream-part IDs.
  return generateUUID().replace(/-/g, '').slice(0, 9);
}

function segmentTextForStream(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let current = '';
  const segments = normalized.split(/(\s+)/);
  for (const segment of segments) {
    const next = `${current}${segment}`;
    if (current.length >= 48 && /\s/.test(segment)) {
      chunks.push(current);
      current = segment;
      continue;
    }
    if (next.length >= 72 && current.length > 0) {
      chunks.push(current);
      current = segment;
      continue;
    }
    current = next;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [normalized];
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

    const messages = convertMessages(options.prompt);

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

    // Build content array (V2 format)
    const content: LanguageModelV2Content[] = [];

    if (result.reasoningText) {
      content.push({
        type: 'reasoning',
        text: result.reasoningText,
      } as LanguageModelV2Content);
    }

    // Add text content if present
    if (result.text) {
      const textContent: LanguageModelV2Text = {
        type: 'text',
        text: result.text,
      };
      content.push(textContent);
    }

    // Convert tool calls to V2 format and add to content
    if (result.toolCalls) {
      for (const tc of result.toolCalls) {
        const toolCall: LanguageModelV2ToolCall = {
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: tc.function.arguments,
        };
        content.push(toolCall);
      }
    }

    // Build usage info (V2 format). `usage` is optional at the IPC boundary;
    // V2 usage fields are `number | undefined`, so missing counts pass through.
    const usage: LanguageModelV2Usage = {
      inputTokens: result.usage?.promptTokens,
      outputTokens: result.usage?.completionTokens,
      totalTokens: result.usage?.totalTokens,
    };

    // Build warnings array (required in V2)
    const warnings: LanguageModelV2CallWarning[] = [];

    return {
      content,
      finishReason: mapFinishReason(result.finishReason),
      usage,
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
        const reasoningId = generateId();
        parts.push({ type: 'reasoning-start', id: reasoningId });
        for (const delta of segmentTextForStream(item.text)) {
          parts.push({ type: 'reasoning-delta', id: reasoningId, delta });
        }
        parts.push({ type: 'reasoning-end', id: reasoningId });
      } else if (item.type === 'text') {
        const textId = generateId();
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
