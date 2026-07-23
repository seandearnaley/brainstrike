import type { LocalLlmToolCall } from './types';

export const LOCAL_TOOL_CALL_ARGUMENTS_INVALID = 'local_tool_call_arguments_invalid';

export class LocalToolCallArgumentsError extends Error {
  readonly code = LOCAL_TOOL_CALL_ARGUMENTS_INVALID;

  constructor() {
    super(
      `${LOCAL_TOOL_CALL_ARGUMENTS_INVALID}: The local model produced malformed JSON arguments for a tool call. The call was rejected before approval or execution.`
    );
    this.name = 'LocalToolCallArgumentsError';
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Validate the model-owned argument text at the provider projection boundary.
 * Local tools use root-object schemas, so a valid JSON scalar/array is not a
 * callable input. Returning canonical JSON also keeps the host, Mastra, and
 * durable approval snapshot byte-consistent.
 */
export function normalizeLocalToolCallArguments(argumentsText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText) as unknown;
  } catch {
    throw new LocalToolCallArgumentsError();
  }
  if (!isJsonObject(parsed)) {
    throw new LocalToolCallArgumentsError();
  }
  return JSON.stringify(parsed);
}

export function normalizeLocalToolCalls(
  toolCalls: readonly LocalLlmToolCall[] | undefined
): LocalLlmToolCall[] {
  if (!toolCalls) {
    return [];
  }
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: normalizeLocalToolCallArguments(toolCall.function.arguments),
    },
  }));
}
