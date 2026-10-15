/**
 * Shared AI SDK v2 ↔ local-LLM message/tool conversion.
 *
 * Used by the llm-host proxy model (Electron main → hidden llm-host renderer)
 * and by the llm-host renderer itself, so the Mastra agent loop sees the same
 * prompt dialect on both sides of that bridge.
 */
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import { generateUUID } from '@brainstrike/utils';
import { normalizeLocalToolCalls } from './local-tool-call-validation';
import type {
  LocalLlmGenerationResult,
  LocalLlmJsonSchema,
  LocalLlmMessage,
  LocalLlmToolCall,
  LocalLlmToolDefinition,
} from './types';

interface TextPart {
  text: string;
  type: 'text';
}

interface ToolResultOutput {
  type: 'content' | 'error-json' | 'error-text' | 'json' | 'text';
  value: unknown;
}

/**
 * Extract text from content array parts
 */
export function extractTextFromParts(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const textParts = content
    .filter((part): part is TextPart => part?.type === 'text')
    .map((part) => part.text);
  return textParts.length > 0 ? textParts.join('\n') : null;
}

function isToolResultOutput(value: unknown): value is ToolResultOutput {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === 'text' ||
    type === 'json' ||
    type === 'error-text' ||
    type === 'error-json' ||
    type === 'content'
  );
}

/**
 * Resolve the tool response payload from a V2 tool-result part.
 *
 * The AI SDK v2 prompt dialect (what Mastra sends) carries
 * `output: { type, value }`; the legacy dialect used a bare `result` field.
 * Error variants are wrapped as `{ error }` to match how the UI tool bridge
 * reports failed executions to the local engine.
 */
function resolveToolResultResponse(part: Record<string, unknown>): unknown {
  const output = part['output'];
  if (isToolResultOutput(output)) {
    if (output.type === 'error-text' || output.type === 'error-json') {
      return { error: output.value };
    }
    return output.value;
  }
  return part['result'];
}

/**
 * Parse a tool result message
 */
export function parseToolResultMessage(content: unknown): LocalLlmMessage[] {
  const results: LocalLlmMessage[] = [];
  if (!Array.isArray(content)) {
    return results;
  }

  for (const part of content) {
    if (part?.type !== 'tool-result') {
      continue;
    }
    const response = resolveToolResultResponse(part as Record<string, unknown>);
    const toolMsg: LocalLlmMessage = {
      content: '',
      role: 'tool',
    };
    if (typeof part.toolCallId === 'string') {
      toolMsg.toolCallId = part.toolCallId;
    }
    if (typeof part.toolName === 'string' && part.toolName.trim().length > 0) {
      toolMsg.toolResponses = [
        {
          name: part.toolName,
          response,
        },
      ];
    } else {
      toolMsg.content = typeof response === 'string' ? response : JSON.stringify(response);
    }
    results.push(toolMsg);
  }
  return results;
}

/**
 * Extract assistant tool calls from V2 content parts.
 *
 * The local engine's chat template needs prior assistant tool calls in the
 * prompt (paired with the tool-result messages) for multi-step tool loops.
 */
export function extractToolCallsFromParts(content: unknown): LocalLlmToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const toolCalls: LocalLlmToolCall[] = [];
  for (const part of content) {
    if (part?.type !== 'tool-call' || typeof part.toolName !== 'string') {
      continue;
    }
    const input: unknown = part.input;
    toolCalls.push({
      function: {
        arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
        name: part.toolName,
      },
      id: typeof part.toolCallId === 'string' ? part.toolCallId : generateUUID(),
      type: 'function',
    });
  }
  return toolCalls;
}

function convertSystemMessage(content: unknown): LocalLlmMessage[] {
  return typeof content === 'string' ? [{ content, role: 'system' }] : [];
}

function convertUserMessage(content: unknown): LocalLlmMessage[] {
  const text = extractTextFromParts(content);
  return text ? [{ content: text, role: 'user' }] : [];
}

function convertAssistantMessage(content: unknown): LocalLlmMessage[] {
  const text = extractTextFromParts(content);
  const toolCalls = extractToolCallsFromParts(content);
  if (!text && toolCalls.length === 0) {
    return [];
  }
  return [
    {
      content: text ?? '',
      role: 'assistant',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
  ];
}

function convertPromptMessage(msg: { content: unknown; role: string }): LocalLlmMessage[] {
  switch (msg.role) {
    case 'system':
      return convertSystemMessage(msg.content);
    case 'user':
      return convertUserMessage(msg.content);
    case 'assistant':
      return convertAssistantMessage(msg.content);
    case 'tool':
      return parseToolResultMessage(msg.content);
    default:
      return [];
  }
}

/**
 * Convert AI SDK v2 messages to LocalLlmMessage format
 */
export function convertPromptToLocalMessages(
  prompt: LanguageModelV2CallOptions['prompt']
): LocalLlmMessage[] {
  if (!Array.isArray(prompt)) {
    return [];
  }

  const result: LocalLlmMessage[] = [];
  for (const msg of prompt) {
    // Skip null/undefined/primitive entries from permissive callers.
    if (msg === null || msg === undefined || typeof msg !== 'object') {
      continue;
    }
    result.push(...convertPromptMessage(msg));
  }
  return result;
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeNullableAnyOf(
  schema: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  const anyOf = schema['anyOf'];
  if (anyOf === undefined) {
    return schema;
  }
  if (!Array.isArray(anyOf)) {
    throw new Error(`Unsupported local tool schema at ${path}: anyOf must be an array.`);
  }
  const nullBranches = anyOf.filter(
    (branch) => isSchemaRecord(branch) && branch['type'] === 'null'
  );
  const valueBranches = anyOf.filter(
    (branch) => !(isSchemaRecord(branch) && branch['type'] === 'null')
  );
  if (
    nullBranches.length !== 1 ||
    valueBranches.length !== 1 ||
    !isSchemaRecord(valueBranches[0])
  ) {
    throw new Error(
      `Unsupported local tool schema at ${path}: anyOf must contain one schema and one null branch.`
    );
  }
  const { anyOf: _ignoredAnyOf, ...outerSchema } = schema;
  return {
    ...valueBranches[0],
    ...outerSchema,
    nullable: true,
  };
}

function normalizeSchemaType(rawType: unknown, path: string): { nullable: boolean; type: string } {
  if (typeof rawType === 'string' && rawType !== 'null') {
    return { nullable: false, type: rawType };
  }
  if (Array.isArray(rawType)) {
    const valueTypes = rawType.filter((candidate) => candidate !== 'null');
    const nullable = rawType.includes('null');
    if (nullable && valueTypes.length === 1 && typeof valueTypes[0] === 'string') {
      return { nullable: true, type: valueTypes[0] };
    }
  }
  throw new Error(`Unsupported local tool schema at ${path}: type must be a concrete JSON type.`);
}

function normalizeLocalToolSchema(value: unknown, path: string): LocalLlmJsonSchema {
  if (!isSchemaRecord(value)) {
    throw new Error(`Unsupported local tool schema at ${path}: schema must be an object.`);
  }
  if (Object.keys(value).length === 0) {
    return { type: 'object' };
  }
  const nullableSchema = normalizeNullableAnyOf(value, path);
  const normalizedType = normalizeSchemaType(nullableSchema['type'], path);
  const normalized: Record<string, unknown> = {
    ...nullableSchema,
    type: normalizedType.type,
    ...(normalizedType.nullable ? { nullable: true } : {}),
  };

  const properties = nullableSchema['properties'];
  if (properties !== undefined) {
    if (!isSchemaRecord(properties)) {
      throw new Error(`Unsupported local tool schema at ${path}: properties must be an object.`);
    }
    normalized['properties'] = Object.fromEntries(
      Object.entries(properties).map(([key, propertySchema]) => [
        key,
        normalizeLocalToolSchema(propertySchema, `${path}.properties.${key}`),
      ])
    );
  }

  if (nullableSchema['items'] !== undefined) {
    normalized['items'] = normalizeLocalToolSchema(nullableSchema['items'], `${path}.items`);
  }

  return normalized as LocalLlmJsonSchema;
}

/**
 * Convert AI SDK v2 tool array to LocalLlmToolDefinition format
 */
export function convertToolsFromArray(
  tools?: LanguageModelV2CallOptions['tools']
): LocalLlmToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return;
  }

  return tools
    .filter((tool): tool is LanguageModelV2FunctionTool => tool.type === 'function')
    .map((tool) => ({
      function: {
        description: tool.description ?? '',
        name: tool.name,
        parameters: normalizeLocalToolSchema(
          tool.inputSchema,
          tool.name
        ) as LocalLlmToolDefinition['function']['parameters'],
      },
      type: 'function' as const,
    }));
}

/**
 * Map finish reason to AI SDK v2 format
 */
export function mapFinishReason(
  reason: 'stop' | 'length' | 'tool_calls'
): LanguageModelV2FinishReason {
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
 * Build the AI SDK v2 content array (reasoning, text, tool calls) from a
 * local-LLM generation result.
 */
export function buildV2ContentFromResult(
  result: LocalLlmGenerationResult
): LanguageModelV2Content[] {
  const content: LanguageModelV2Content[] = [];

  if (result.reasoningText) {
    content.push({
      text: result.reasoningText,
      type: 'reasoning',
    } as LanguageModelV2Content);
  }

  if (result.text) {
    content.push({ text: result.text, type: 'text' });
  }

  for (const toolCall of normalizeLocalToolCalls(result.toolCalls)) {
    content.push({
      input: toolCall.function.arguments,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      type: 'tool-call',
    });
  }

  return content;
}

/**
 * Build AI SDK v2 usage from a local-LLM generation result. `usage` is
 * optional at the IPC boundary; V2 usage fields are `number | undefined`, so
 * missing counts pass through.
 */
export function buildV2UsageFromResult(result: LocalLlmGenerationResult): LanguageModelV2Usage {
  return {
    inputTokens: result.usage?.promptTokens,
    outputTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
  };
}

/**
 * Generate a unique ID for stream parts
 */
export function generateStreamPartId(): string {
  // Preserve compact 9-char IDs for stream consumers; this intentionally narrows to hex ([0-9a-f], ~36-bit space) and accepts minor UUID-generation overhead for low-volume stream-part IDs.
  return generateUUID().replace(/-/g, '').slice(0, 9);
}
