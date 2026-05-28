import { toJsonSafe } from './json';

export const TOOL_RESULT_TOO_LARGE_CODE = 'tool_result_too_large';

const MAX_TOOL_RESULT_SERIALIZED_CHARS = 12_000;
const TOOL_RESULT_PREVIEW_CHARS = 8000;

export interface BoundedToolOutput {
  readonly errorText?: string;
  readonly output: unknown;
}

function stringifyJsonSafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sliceCodePoints(value: string, maxCodePoints: number): string {
  let result = '';
  let codePoints = 0;
  for (const codePoint of value) {
    if (codePoints >= maxCodePoints) {
      break;
    }
    result += codePoint;
    codePoints += 1;
  }
  return result;
}

function isBoundedOversizedToolOutput(output: unknown): output is {
  readonly code: typeof TOOL_RESULT_TOO_LARGE_CODE;
  readonly error: string;
  readonly maxLength: number;
  readonly originalLength: number;
  readonly preview: string;
  readonly truncated: true;
} {
  if (!output || typeof output !== 'object') {
    return false;
  }
  const record = output as Record<string, unknown>;
  return (
    record['code'] === TOOL_RESULT_TOO_LARGE_CODE &&
    typeof record['error'] === 'string' &&
    typeof record['maxLength'] === 'number' &&
    typeof record['originalLength'] === 'number' &&
    typeof record['preview'] === 'string' &&
    record['truncated'] === true
  );
}

export function readToolOutputErrorText(output: unknown): string {
  if (typeof output === 'string' && output.length > 0) {
    return output;
  }
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'string' && error.length > 0) {
      return error;
    }
    const message = record['message'];
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return 'Tool execution failed';
}

export function boundToolOutputForModel(toolName: string, output: unknown): BoundedToolOutput {
  if (isBoundedOversizedToolOutput(output)) {
    return { errorText: output.error, output };
  }

  const jsonSafeOutput = toJsonSafe(output);
  const serialized = stringifyJsonSafe(jsonSafeOutput);
  if (serialized.length <= MAX_TOOL_RESULT_SERIALIZED_CHARS) {
    return { output: jsonSafeOutput };
  }

  const preview =
    typeof jsonSafeOutput === 'string'
      ? sliceCodePoints(jsonSafeOutput, TOOL_RESULT_PREVIEW_CHARS)
      : sliceCodePoints(serialized, TOOL_RESULT_PREVIEW_CHARS);
  const errorText = `${toolName} returned too much output (${serialized.length} serialized characters; limit ${MAX_TOOL_RESULT_SERIALIZED_CHARS}). Narrow the request or use a more specific query.`;
  return {
    errorText,
    output: {
      code: TOOL_RESULT_TOO_LARGE_CODE,
      error: errorText,
      maxLength: MAX_TOOL_RESULT_SERIALIZED_CHARS,
      originalLength: serialized.length,
      preview,
      truncated: true,
    },
  };
}
