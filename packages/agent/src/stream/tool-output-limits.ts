import { sliceCodePoints } from '@brainstrike/utils/string-utils';

import { HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET } from '../tools/hook-runner';
import { toJsonSafe } from './json';

export const TOOL_RESULT_TOO_LARGE_CODE = 'tool_result_too_large';
export const TOOL_RESULT_TRUNCATED_CODE = 'tool_result_truncated';

/** Mirrors countTokensHeuristic (ceil(chars / 4)) so budgets stay deterministic. */
const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Tool result budgets are denominated in (heuristic) tokens — the unit the
 * model reasons in — and enforced deterministically on serialized characters
 * via the chars-per-token approximation.
 */
export const MAX_TOOL_RESULT_TOKENS = 3000;
/** Default ceiling for the compact value repeated into the next model step. */
export const MAX_MODEL_TOOL_RESULT_TOKENS = 2000;
const TOOL_RESULT_PREVIEW_CHARS = 8000;

/**
 * Budget native tools should bound their own serialized output to. Kept under
 * the transport limit so envelope fields (hints, totals) never tip a
 * self-bounded result over the guard.
 */
export const NATIVE_TOOL_RESULT_TOKEN_BUDGET = 2750;
export const NATIVE_TOOL_RESULT_CHAR_BUDGET =
  NATIVE_TOOL_RESULT_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;

/**
 * Dedicated budget for the `skill` activation tool. A skill activation's
 * result IS the payload (the SKILL.md instructions the model must follow), and
 * the Agent Skills spec allows bodies up to ~5000 tokens — above the generic
 * {@link MAX_TOOL_RESULT_TOKENS} guard, whose "narrow the request" recovery
 * does not exist for an activation. The skill tool self-bounds to this same
 * ceiling with an honest truncation note (see skills/skill-tools.ts), so the
 * transport override below is a backstop, not the working bound.
 */
export const SKILL_ACTIVATION_RESULT_TOKEN_BUDGET = 6000;

/**
 * Per-tool transport-guard budget overrides. Explicit and enumerated — every
 * other tool keeps the generic budget. Keyed by the SANITIZED tool id (the id
 * the data-stream mapper reports).
 */
const TOOL_RESULT_TOKEN_BUDGET_OVERRIDES: Readonly<Record<string, number>> = {
  skill: SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
};

function approxTokensFromChars(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / APPROX_CHARS_PER_TOKEN));
}

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
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isLegacyOversizedToolError(output: unknown): output is {
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

function isBoundedTruncatedToolOutput(output: unknown): output is {
  readonly code: typeof TOOL_RESULT_TRUNCATED_CODE;
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
    record['code'] === TOOL_RESULT_TRUNCATED_CODE &&
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
  // A delegation (`agent-<key>`) tool result carries the child's raw
  // `subAgentToolResults` list; trim it structurally when oversized rather than
  // failing the whole delegation with a hard size error.
  'subAgentToolResults',
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

function buildTruncationHint(
  toolName: string,
  key: string,
  kept: number,
  total: number,
  record: Readonly<Record<string, unknown>>
): string {
  const offset = record['offset'];
  let continuation = ' Narrow the request or use the tool-specific pagination controls.';
  if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) {
    continuation = ` Continue with offset: ${offset + kept}.`;
  } else if (typeof record['hint'] === 'string' && record['hint'].trim().length > 0) {
    continuation = ` Producer hint: ${record['hint']}`;
  }
  return (
    `${toolName} output was truncated to fit the tool result budget: ` +
    `showing ${kept} of ${total} returned ${key}.${continuation}`
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
  key: string,
  maxSerializedChars: number
): Record<string, unknown> | undefined {
  const items = record[key] as unknown[];
  const buildCandidate = (kept: number): Record<string, unknown> => ({
    ...record,
    [key]: items.slice(0, kept),
    hint: buildTruncationHint(toolName, key, kept, items.length, record),
    omittedItems: items.length - kept,
    truncated: true,
  });

  let low = 1;
  let high = items.length - 1;
  let best: Record<string, unknown> | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = buildCandidate(mid);
    if (stringifyJsonSafe(candidate).length <= maxSerializedChars) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function buildPreviewOutput(params: {
  readonly hookAdditionalContext?: string;
  readonly maxSerializedChars: number;
  readonly maxTokens: number;
  readonly originalLength: number;
  readonly preview: string;
  readonly toolName: string;
}): Record<string, unknown> {
  return {
    approxTokens: approxTokensFromChars(params.originalLength),
    code: TOOL_RESULT_TRUNCATED_CODE,
    hint:
      `${params.toolName} output was truncated to a preview because it exceeded the tool result budget ` +
      `(~${approxTokensFromChars(params.originalLength)} tokens; budget ~${params.maxTokens} tokens). ` +
      'Narrow the request or use a more specific query.',
    maxLength: params.maxSerializedChars,
    maxTokens: params.maxTokens,
    originalLength: params.originalLength,
    preview: params.preview,
    truncated: true,
    ...(params.hookAdditionalContext
      ? { hookAdditionalContext: params.hookAdditionalContext }
      : {}),
  };
}

function createBoundedPreviewOutput(params: {
  readonly hookAdditionalContext?: string;
  readonly maxSerializedChars: number;
  readonly maxTokens: number;
  readonly originalLength: number;
  readonly previewSource: string;
  readonly toolName: string;
}): Record<string, unknown> {
  const hookAdditionalContext = fitHookContextToPreviewBudget(params);
  const boundedParams = {
    ...params,
    ...(hookAdditionalContext ? { hookAdditionalContext } : {}),
  };
  const envelopeReserve = 512;
  const initialPreviewChars = Math.min(
    TOOL_RESULT_PREVIEW_CHARS,
    Math.max(0, params.maxSerializedChars - envelopeReserve)
  );
  const initial = buildPreviewOutput({
    ...boundedParams,
    preview: sliceCodePoints(params.previewSource, initialPreviewChars),
  });
  if (stringifyJsonSafe(initial).length <= params.maxSerializedChars) {
    return initial;
  }

  // JSON escaping can expand a raw control character to six characters. Use
  // that worst-case ratio only when the readable first candidate did not fit;
  // this remains bounded work and never walks the unbounded tail.
  const empty = buildPreviewOutput({ ...boundedParams, preview: '' });
  const availableChars = Math.max(0, params.maxSerializedChars - stringifyJsonSafe(empty).length);
  return buildPreviewOutput({
    ...boundedParams,
    preview: sliceCodePoints(params.previewSource, Math.floor(availableChars / 6)),
  });
}

function fitHookContextToPreviewBudget(params: {
  readonly hookAdditionalContext?: string;
  readonly maxSerializedChars: number;
  readonly maxTokens: number;
  readonly originalLength: number;
  readonly toolName: string;
}): string | undefined {
  const context = params.hookAdditionalContext;
  if (!context) {
    return;
  }
  const build = (hookAdditionalContext?: string): Record<string, unknown> =>
    buildPreviewOutput({
      ...params,
      ...(hookAdditionalContext ? { hookAdditionalContext } : {}),
      preview: '',
    });
  if (stringifyJsonSafe(build(context)).length <= params.maxSerializedChars) {
    return context;
  }

  const suffix = '… [hook context truncated]';
  let low = 0;
  let high = Math.min(context.length, HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET);
  let best: string | undefined;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = `${sliceCodePoints(context, kept)}${suffix}`;
    if (stringifyJsonSafe(build(candidate)).length <= params.maxSerializedChars) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best;
}

export function boundToolOutputForModel(
  toolName: string,
  output: unknown,
  maxTokensOverride?: number
): BoundedToolOutput {
  const maxTokens =
    maxTokensOverride ?? TOOL_RESULT_TOKEN_BUDGET_OVERRIDES[toolName] ?? MAX_TOOL_RESULT_TOKENS;
  const maxSerializedChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const jsonSafeOutput = toJsonSafe(output);
  const serialized = stringifyJsonSafe(jsonSafeOutput);

  // Recognized envelopes are idempotent only when they fit the ACTIVE budget.
  // Tool output is untrusted (especially MCP), so shape alone must never bypass
  // serialization or a tighter 3000→2000-token projection boundary.
  if (serialized.length <= maxSerializedChars) {
    if (isLegacyOversizedToolError(jsonSafeOutput)) {
      return { errorText: jsonSafeOutput.error, output: jsonSafeOutput };
    }
    if (isBoundedTruncatedToolOutput(jsonSafeOutput)) {
      return { output: jsonSafeOutput };
    }
  }
  if (serialized.length <= maxSerializedChars) {
    return { output: jsonSafeOutput };
  }

  if (isLegacyOversizedToolError(jsonSafeOutput)) {
    const errorText = sliceCodePoints(jsonSafeOutput.error, 256);
    const legacyErrorReserveChars = 2048;
    const preview = createBoundedPreviewOutput({
      maxSerializedChars: maxSerializedChars - legacyErrorReserveChars,
      maxTokens,
      originalLength: serialized.length,
      previewSource: serialized,
      toolName,
    });
    return {
      errorText,
      output: {
        ...preview,
        code: TOOL_RESULT_TOO_LARGE_CODE,
        error: errorText,
        maxLength: maxSerializedChars,
      },
    };
  }

  // Structural degradation: trim a recognizable result list to fit and return
  // a SUCCESSFUL partial result (truncated + hint) instead of a tool error.
  if (isPlainRecordOutput(jsonSafeOutput)) {
    const collectionKey = findTrimmableCollectionKey(jsonSafeOutput);
    if (collectionKey) {
      const trimmed = trimCollectionToBudget(
        toolName,
        jsonSafeOutput,
        collectionKey,
        maxSerializedChars
      );
      if (trimmed) {
        return { output: trimmed };
      }
    }
  }

  const hookAdditionalContext =
    isPlainRecordOutput(jsonSafeOutput) &&
    typeof jsonSafeOutput['hookAdditionalContext'] === 'string'
      ? sliceCodePoints(
          jsonSafeOutput['hookAdditionalContext'],
          HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET
        )
      : undefined;
  let previewSource = typeof jsonSafeOutput === 'string' ? jsonSafeOutput : serialized;
  if (hookAdditionalContext && isPlainRecordOutput(jsonSafeOutput)) {
    const previewRecord = { ...jsonSafeOutput };
    previewRecord['hookAdditionalContext'] = undefined;
    previewSource = stringifyJsonSafe(previewRecord);
  }

  return {
    output: createBoundedPreviewOutput({
      ...(hookAdditionalContext ? { hookAdditionalContext } : {}),
      maxSerializedChars,
      maxTokens,
      originalLength: serialized.length,
      previewSource,
      toolName,
    }),
  };
}
