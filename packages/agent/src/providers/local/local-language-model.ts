/**
 * AI SDK v1 compatible language model wrapper for local LLM inference.
 *
 * Wraps the LocalLlmBackend to provide compatibility with Mastra's MastraModelConfig type.
 */
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1FinishReason,
  LanguageModelV1FunctionTool,
  LanguageModelV1FunctionToolCall,
  LanguageModelV1StreamPart,
} from '@ai-sdk/provider';
import { LocalLlmBackend } from './local-llm-backend';
import type { LocalLlmMessage, LocalLlmToolDefinition } from './types';

type LocalLanguageModelSettings = {
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
};

type TextPart = { type: 'text'; text: string };

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
      content: typeof part.result === 'string' ? part.result : JSON.stringify(part.result),
    };
    if (part.toolCallId !== undefined) {
      toolMsg.toolCallId = part.toolCallId;
    }
    results.push(toolMsg);
  }
  return results;
}

/**
 * Convert AI SDK messages to LocalLlmMessage format
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Message parsing requires handling multiple roles
function convertMessages(prompt: LanguageModelV1CallOptions['prompt']): LocalLlmMessage[] {
  const result: LocalLlmMessage[] = [];

  if (!Array.isArray(prompt)) {
    return result;
  }

  for (const msg of prompt) {
    if (!msg || typeof msg !== 'object') {
      continue;
    }

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
 * Convert AI SDK tool array to LocalLlmToolDefinition format
 */
function convertToolsFromArray(
  tools?: Array<LanguageModelV1FunctionTool | { type: string }>
): LocalLlmToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return;
  }

  return tools
    .filter((tool): tool is LanguageModelV1FunctionTool => tool.type === 'function')
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters as LocalLlmToolDefinition['function']['parameters'],
      },
    }));
}

/**
 * Map finish reason to AI SDK format
 */
function mapFinishReason(reason: 'stop' | 'length' | 'tool_calls'): LanguageModelV1FinishReason {
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
 * AI SDK v1 compatible language model for local inference
 */
export class LocalLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly provider = 'local';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;

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
    options: LanguageModelV1CallOptions
  ): PromiseLike<Awaited<ReturnType<LanguageModelV1['doGenerate']>>> {
    return this.executeGenerate(options);
  }

  private async executeGenerate(
    options: LanguageModelV1CallOptions
  ): Promise<Awaited<ReturnType<LanguageModelV1['doGenerate']>>> {
    await this.ensureInitialized();

    const messages = convertMessages(options.prompt);

    // Extract tools from mode if applicable
    let tools: LocalLlmToolDefinition[] | undefined;
    if (options.mode.type === 'regular' && 'tools' in options.mode && options.mode.tools) {
      tools = convertToolsFromArray(options.mode.tools);
    }

    // Build generation options conditionally to satisfy exactOptionalPropertyTypes
    const generateOptions: {
      maxNewTokens: number;
      temperature?: number;
      topP?: number;
      topK?: number;
      tools?: LocalLlmToolDefinition[];
      signal?: AbortSignal;
    } = {
      maxNewTokens: options.maxTokens ?? this.settings.maxNewTokens ?? 512,
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

    if (options.abortSignal !== undefined) {
      generateOptions.signal = options.abortSignal;
    }

    const result = await this.backend.generate(messages, generateOptions);

    // Convert tool calls to AI SDK format
    const toolCalls: LanguageModelV1FunctionToolCall[] | undefined = result.toolCalls?.map(
      (tc) => ({
        toolCallType: 'function' as const,
        toolCallId: tc.id,
        toolName: tc.function.name,
        args: tc.function.arguments,
      })
    );

    // Build the result object with optional properties only when defined
    const generateResult: Awaited<ReturnType<LanguageModelV1['doGenerate']>> = {
      finishReason: mapFinishReason(result.finishReason),
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      },
      rawCall: {
        rawPrompt: messages,
        rawSettings: {
          maxNewTokens: options.maxTokens,
          temperature: options.temperature,
          topP: options.topP,
          topK: options.topK,
        },
      },
    };

    // Only add optional properties if they have values
    if (result.text) {
      generateResult.text = result.text;
    }

    if (toolCalls && toolCalls.length > 0) {
      generateResult.toolCalls = toolCalls;
    }

    return generateResult;
  }

  doStream(
    options: LanguageModelV1CallOptions
  ): PromiseLike<Awaited<ReturnType<LanguageModelV1['doStream']>>> {
    return this.executeStream(options);
  }

  private async executeStream(
    options: LanguageModelV1CallOptions
  ): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> {
    // For now, we simulate streaming by doing a full generation and streaming the result
    // The LocalLlmBackend doesn't support true streaming yet
    const result = await this.executeGenerate(options);

    const parts: LanguageModelV1StreamPart[] = [];

    // Stream text if present
    if (result.text) {
      parts.push({ type: 'text-delta', textDelta: result.text });
    }

    // Stream tool calls if present
    if (result.toolCalls) {
      for (const tc of result.toolCalls) {
        parts.push({
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        });
      }
    }

    // Add finish part
    parts.push({
      type: 'finish',
      finishReason: result.finishReason,
      usage: result.usage,
    });

    // Create a ReadableStream from the parts
    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });

    return {
      stream,
      rawCall: result.rawCall,
    };
  }
}

/**
 * Create a local language model instance
 */
export function createLocalLanguageModel(
  modelId: string,
  settings?: LocalLanguageModelSettings
): LanguageModelV1 {
  return new LocalLanguageModel(modelId, settings);
}
