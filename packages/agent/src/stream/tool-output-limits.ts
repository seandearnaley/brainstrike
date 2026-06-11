import { sliceCodePoints } from '@brainstrike/utils/string-utils';

import { toJsonSafe } from './json';

export const TOOL_RESULT_TOO_LARGE_CODE = 'tool_result_too_large';

const MAX_TOOL_RESULT_SERIALIZED_CHARS = 12_000;
const TOOL_RESULT_PREVIEW_CHARS = 8000;

/**
 * Budget native tools should bound their own serialized output to. Kept under
 * the transport limit so envelope fields (hints, totals) never tip a
 * self-bounded result over the guard.
 */
export const NATIVE_TOOL_RESULT_CHAR_BUDGET = 11_000;

/**
 * Fit the largest prefix of `items` whose built result serializes within
 * `budget` characters. Tools use this to self-bound result lists BEFORE the
 * transport guard, so the model always receives valid partial data (plus the
 * tool's own truncation fields/hints) instead of a size error.
 */
export function fitItemsToCharBudget<TItem, TResult>(
  items: readonly TItem[],
  build: (kept: TItem[]) => TResult,
  budget: number = NATIVE_TOOL_RESULT_CHAR_BUDGET
): { kept: number; result: TResult } {
  const serializedLength = (result: TResult): number =>
    stringifyJsonSafe(toJsonSafe(result)).length;

  const full = build(items.slice());
  if (serializedLength(full) <= budget) {
    return { kept: items.length, result: full };
  }

  let low = 0;
  let high = items.length - 1;
  let best: { kept: number; result: TResult } = { kept: 0, result: build([]) };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(items.slice(0, mid));
    if (serializedLength(candidate) <= budget) {
      best = { kept: mid, result: candidate };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

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

/**
 * Result-list keys the guard knows how to trim. When an oversized output is a
 * record carrying one of these arrays, the guard drops tail items until the
 * result fits instead of failing the whole call — partial data plus an explicit
 * `hint` beats an error the model has to guess its way around.
 */
const TRIMMABLE_COLLECTION_KEYS = [
  'matches',
  'entries',
  'results',
  'items',
  'files',
  'chunks',
  'rows',
] as const;

function isPlainRecordOutput(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function findTrimmableCollectionKey(record: Record<string, unknown>): string | undefined {
  return TRIMMABLE_COLLECTION_KEYS.find((key) => {
    const value = record[key];
    return Array.isArray(value) && value.length > 1;
  });
}

function buildTruncationHint(toolName: string, key: string, kept: number, total: number): string {
  return (
    `${toolName} output was truncated to fit the tool result budget: showing ${kept} of ${total} ${key}. ` +
    'Narrow the request (more specific filters, smaller limits) or page through the remainder ' +
    `with an offset of ${kept} if the tool supports it.`
  );
}

/**
 * Binary-search the largest prefix of the collection that fits the budget.
 * Returns undefined when even a single item does not fit (caller falls back to
 * the opaque-preview error path).
 */
function trimCollectionToBudget(
  toolName: string,
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const items = record[key] as unknown[];
  const buildCandidate = (kept: number): Record<string, unknown> => ({
    ...record,
    [key]: items.slice(0, kept),
    truncated: true,
    omittedItems: items.length - kept,
    hint: buildTruncationHint(toolName, key, kept, items.length),
  });

  let low = 1;
  let high = items.length - 1;
  let best: Record<string, unknown> | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = buildCandidate(mid);
    if (stringifyJsonSafe(candidate).length <= MAX_TOOL_RESULT_SERIALIZED_CHARS) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
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

  // Structural degradation: trim a recognizable result list to fit and return
  // a SUCCESSFUL partial result (truncated + hint) instead of a tool error.
  if (isPlainRecordOutput(jsonSafeOutput)) {
    const collectionKey = findTrimmableCollectionKey(jsonSafeOutput);
    if (collectionKey) {
      const trimmed = trimCollectionToBudget(toolName, jsonSafeOutput, collectionKey);
      if (trimmed) {
        return { output: trimmed };
      }
    }
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
