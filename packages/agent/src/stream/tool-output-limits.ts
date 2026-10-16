import { DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW } from '@brainstrike/assistant-contract/context-budget';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import {
  findLlmModelDefinition,
  findProviderDefinition,
  type ProviderId,
} from '@brainstrike/assistant-contract/provider-registry';
import { createLogger } from '@brainstrike/logging';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';

import { HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET } from '../tools/hook-runner';
import { toJsonSafe } from './json';

const logger = createLogger('ToolOutputLimits');

export const TOOL_RESULT_TOO_LARGE_CODE = 'tool_result_too_large';
export const TOOL_RESULT_TRUNCATED_CODE = 'tool_result_truncated';

/** Mirrors countTokensHeuristic (ceil(chars / 4)) so budgets stay deterministic. */
export const APPROX_CHARS_PER_TOKEN = 4;

export const TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW = 131_072;
const DOMAIN_TOOL_RESULT_TOKEN_FLOOR = 500;
const TRANSPORT_TOOL_RESULT_TOKEN_FLOOR = 1000;
const DOMAIN_TOOL_RESULT_TOKEN_CEILING = 3000;
const TRANSPORT_TOOL_RESULT_TOKEN_CEILING = 6000;

/**
 * The 128k-anchor transport definition used by
 * {@link resolveScaledToolResultBudget}. Per-run defaults scale linearly from
 * this value, round to the nearest token, and clamp to 1000..6000 tokens.
 * Tool result budgets are enforced deterministically on serialized characters
 * via the chars-per-token approximation.
 */
export const MAX_TOOL_RESULT_TOKENS = 3000;
/** Default ceiling for the compact value repeated into the next model step. */
export const MAX_MODEL_TOOL_RESULT_TOKENS = 2000;
export const MAX_MODEL_TOOL_RESULT_CHAR_BUDGET =
  MAX_MODEL_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN;
/**
 * The 128k-anchor domain definition used by
 * {@link resolveScaledToolResultBudget}. Per-run defaults scale linearly from
 * this value, round to the nearest token, and clamp to 500..3000 tokens.
 * Purpose-built domain projections must leave deterministic room for bounded
 * PostToolUse guidance inside the total model-result envelope. BST-1219 also
 * threads the resolved per-run value into desktop's domain projectors, so this
 * anchor remains only their backward-compatible default when no run budget is
 * supplied.
 */
export const MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS = 1500;
export const MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET =
  MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN;
const TOOL_RESULT_PREVIEW_CHARS = 8000;

export interface ScaledToolResultBudget {
  readonly contextWindow: number;
  readonly domainModelResultCharBudget: number;
  readonly domainModelResultTokens: number;
  readonly transportResultCharBudget: number;
  readonly transportResultTokens: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Resolve the two model-aware default tool-result budgets for one run.
 * The 131,072-token anchor preserves the historical 1500/3000-token values;
 * scaling is linear, rounded to the nearest token, and clamped to the fixed
 * 500/1000 floors and 3000/6000 ceilings.
 */
export function resolveScaledToolResultBudget(contextWindow: number): ScaledToolResultBudget {
  if (!(Number.isSafeInteger(contextWindow) && contextWindow > 0)) {
    throw new TypeError(`contextWindow must be a positive safe integer, got ${contextWindow}`);
  }
  const scaleFactor = contextWindow / TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW;
  const domainModelResultTokens = clamp(
    Math.round(MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS * scaleFactor),
    DOMAIN_TOOL_RESULT_TOKEN_FLOOR,
    DOMAIN_TOOL_RESULT_TOKEN_CEILING
  );
  const transportResultTokens = clamp(
    Math.round(MAX_TOOL_RESULT_TOKENS * scaleFactor),
    TRANSPORT_TOOL_RESULT_TOKEN_FLOOR,
    TRANSPORT_TOOL_RESULT_TOKEN_CEILING
  );
  return {
    contextWindow,
    domainModelResultCharBudget: domainModelResultTokens * APPROX_CHARS_PER_TOKEN,
    domainModelResultTokens,
    transportResultCharBudget: transportResultTokens * APPROX_CHARS_PER_TOKEN,
    transportResultTokens,
  };
}

/** Fixed replay-acceptance tier: stored projections may use any shipped budget. */
export const CEILING_SCALED_TOOL_RESULT_BUDGET: ScaledToolResultBudget = Object.freeze({
  contextWindow: TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW * 2,
  domainModelResultCharBudget: DOMAIN_TOOL_RESULT_TOKEN_CEILING * APPROX_CHARS_PER_TOKEN,
  domainModelResultTokens: DOMAIN_TOOL_RESULT_TOKEN_CEILING,
  transportResultCharBudget: TRANSPORT_TOOL_RESULT_TOKEN_CEILING * APPROX_CHARS_PER_TOKEN,
  transportResultTokens: TRANSPORT_TOOL_RESULT_TOKEN_CEILING,
});

/**
 * Resolve a run's tool-result budget from its provider/model. `getLlmModelDefinition`
 * is NOT a hard precondition for starting a run: a budget default is a
 * best-effort convenience, not a capability the run actually needs, so an
 * unknown provider/model id must never kill a run over it.
 *
 * - Runtime-discovered Ollama/LM Studio model ids are NEVER in the static
 *   catalog by design (they're discovered live from a local server), so
 *   falling back to the existing conservative `DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW`
 *   declaration is expected, routine behavior for those two providers —
 *   not logged, the same way it was not logged before this function existed.
 * - Any OTHER unknown id — notably an OpenRouter metadata-only / auto-profile
 *   model (`mergeOpenRouterAutoProfileModel`, no catalog entry by design) or a
 *   persisted preference from a retired catalog entry — is a genuinely
 *   unexpected miss for a provider whose models are normally catalog-backed,
 *   so it falls back to the 128k ANCHOR (the exact pre-BST-1206 fixed-budget
 *   behavior) WITH a visible log: not a silent fallback, the documented
 *   default, logged so it stays visible.
 *
 * Uses the non-throwing `findLlmModelDefinition` rather than try/catch, so a
 * genuine registry misconfiguration (e.g. a registered entry with a bad
 * `contextWindow`) still throws through `resolveScaledToolResultBudget`
 * instead of being silently swallowed as "unknown model".
 */
export function resolveToolResultBudgetForModel(
  providerId: ProviderId,
  modelId: string
): ScaledToolResultBudget {
  const definition = findLlmModelDefinition(providerId, modelId);
  if (definition) {
    return resolveScaledToolResultBudget(definition.contextWindow);
  }
  // Guarded lookup: providerId can be an unvalidated persona-pin cast, so an
  // out-of-registry id must reach the documented warn+anchor fallback below —
  // never a TypeError (PR #2513 review, finding 1).
  if (findProviderDefinition(providerId)?.runtime === 'local') {
    // Local-runtime servers (registry `runtime: 'local'`) discover their
    // model catalogs dynamically, so no static definition exists.
    return resolveScaledToolResultBudget(DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW);
  }
  logger.warn('Unknown model id for tool-result budget resolution; using fallback window', {
    code: 'tool_result_budget_unknown_model_fallback',
    fallbackContextWindow: TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW,
    modelId,
    providerId,
  });
  return resolveScaledToolResultBudget(TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW);
}

/**
 * BST-1195: the decoded-text domain-projection ruler. Desktop's purpose-built
 * TEXT projectors (`workspace-model-projection-helpers.ts`) and this
 * package's own domain-projection runtime guards
 * (`../tool-projection/tool-model-output.ts`: `assertDomainProjectionWithinBudget` and
 * `composeHookContextWithProjection`) share this ONE measurement
 * implementation. PR #2334 review caught exactly the earlier ruler
 * divergence: the projectors switched to decoded length, but the runtime
 * guard directly downstream kept measuring
 * `JSON.stringify({type:'text',value}).length` — so a page that legitimately
 * fit the domain budget
 * could still throw a `RangeError` a moment later at the runtime gate,
 * because JSON-escaping made it look oversized again. JSON/`content`-typed
 * domain projections are unaffected by BST-1195 and keep measuring full
 * serialized size — only `type: 'text'` outputs use this ruler.
 *
 * Value derivation for the reserve: the OLD ruler measured
 * `JSON.stringify({ type: 'text', value }).length`, which for the empty
 * string is exactly 26 (`{"type":"text","value":""}.length === 26`) — the
 * fixed structural overhead of the envelope. JSON escaping can only ADD
 * characters relative to the raw string (never remove), and code-point
 * counting can only be <= UTF-16 length (astral pairs collapse). Therefore
 * for ANY string X: codePointLength(X) + 26 <= JSON.stringify({type:'text',
 * value:X}).length — a value that fit the old serialized budget is
 * guaranteed to still fit this one, so a stored/replayed projection never
 * newly throws. Do not "round up" this constant without re-deriving the
 * proof above.
 */
export const PROJECTION_ENVELOPE_RESERVE_CHARS = 26;

/**
 * Decoded-text domain-projection char count: code points in the value the
 * model actually reads, plus {@link PROJECTION_ENVELOPE_RESERVE_CHARS}. This
 * is the ONE measurement a purpose-built TEXT domain projection (and the
 * runtime guards that re-check its output) must use against its active
 * domain-character budget — never site-local `JSON.stringify(...).length`
 * math. {@link MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET} is the 128k anchor;
 * active runs use {@link resolveScaledToolResultBudget}.
 */
export function decodedTextModelOutputChars(value: string): number {
  return Array.from(value).length + PROJECTION_ENVELOPE_RESERVE_CHARS;
}

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
 * A full activation plus bounded PostToolUse guidance needs a wider
 * model-facing envelope than the activation payload alone. The fixed reserve
 * covers the normalized `{type,value}` structure and its JSON escaping.
 */
const MODEL_PROJECTION_STRUCTURAL_RESERVE_TOKENS = 64;
export const SKILL_ACTIVATION_DOMAIN_MODEL_RESULT_CHAR_BUDGET =
  (SKILL_ACTIVATION_RESULT_TOKEN_BUDGET + MODEL_PROJECTION_STRUCTURAL_RESERVE_TOKENS) *
  APPROX_CHARS_PER_TOKEN;
export const SKILL_ACTIVATION_MODEL_RESULT_TOKEN_BUDGET =
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET +
  Math.ceil(HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET / APPROX_CHARS_PER_TOKEN) +
  MODEL_PROJECTION_STRUCTURAL_RESERVE_TOKENS;
export const SKILL_ACTIVATION_MODEL_RESULT_CHAR_BUDGET =
  SKILL_ACTIVATION_MODEL_RESULT_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;

/**
 * Model-projection envelope for native tools that self-bound their result to
 * {@link NATIVE_TOOL_RESULT_CHAR_BUDGET} and rely on the generic projection
 * (runPython, runSkillScript, skill_read, skill_search, and the
 * fitItemsToCharBudget default-budget callers without custom projectors:
 * manageTaskList, readWorkspaceDirectory, queryDiagnostics; executeCommand
 * has its own text projection since BST-1201 and uses this envelope only on
 * the dispatcher fail-soft fallback). The
 * tool's own bound — head+tail retention, truncation hints (BST-1189) — is the
 * working limit; this envelope exists so the default projector passes that
 * result through unmodified instead of re-truncating it at the tighter
 * {@link MAX_MODEL_TOOL_RESULT_TOKENS} ceiling and replacing the carefully
 * built fields with a generic prefix preview.
 *
 * The 2x escape reserve is a worst-case bound, not slack: the default
 * projection embeds the serialized result as a JSON string value, and
 * JSON-escaping an already-serialized payload at most doubles it (`"` → `\"`,
 * `\` → `\\`; prior serialization leaves no raw control characters). Sizing
 * the ceiling below that would let quote-heavy output — JSON logs are routine
 * command output — silently lose its tail again.
 *
 * The reserve applies ONLY to these envelope budgets (measured on the
 * re-escaped embedding). The projection's raw-output guard stays at
 * {@link NATIVE_TOOL_RESULT_TOKEN_BUDGET}: a result whose single
 * serialization exceeds the native budget violated its self-bound and is
 * truncated with a visible hint, never passed through.
 */
const SELF_BOUND_ESCAPE_RESERVE_FACTOR = 2;
export const NATIVE_SELF_BOUND_MODEL_RESULT_TOKENS =
  SELF_BOUND_ESCAPE_RESERVE_FACTOR * NATIVE_TOOL_RESULT_TOKEN_BUDGET;
export const NATIVE_SELF_BOUND_DOMAIN_MODEL_RESULT_CHAR_BUDGET =
  (NATIVE_SELF_BOUND_MODEL_RESULT_TOKENS + MODEL_PROJECTION_STRUCTURAL_RESERVE_TOKENS) *
  APPROX_CHARS_PER_TOKEN;
export const NATIVE_SELF_BOUND_MODEL_RESULT_TOKEN_BUDGET =
  NATIVE_SELF_BOUND_MODEL_RESULT_TOKENS +
  Math.ceil(HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET / APPROX_CHARS_PER_TOKEN) +
  MODEL_PROJECTION_STRUCTURAL_RESERVE_TOKENS;
export const NATIVE_SELF_BOUND_MODEL_RESULT_CHAR_BUDGET =
  NATIVE_SELF_BOUND_MODEL_RESULT_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;

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
  };
}

function buildPreviewOmissionMarker(omittedChars: number): string {
  return `…[${omittedChars} chars omitted]…`;
}

/** True when `codeUnit` is the leading half of a UTF-16 surrogate pair. */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff;
}

/** True when `codeUnit` is the trailing half of a UTF-16 surrogate pair. */
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff;
}

/**
 * Arbitrary transport previews retain a balanced 50/50 head and tail. This
 * differs from executeCommand's domain-specific 40/60 stream split because a
 * generic output has no basis for prioritizing recent content over its start.
 */
const PREVIEW_HEAD_RATIO = 0.5;

function splitPreviewHeadTail(source: string, maxChars: number): string {
  const boundedMaxChars = Math.max(0, Math.floor(maxChars));
  if (source.length <= boundedMaxChars) {
    return source;
  }

  // The omitted count cannot have more digits than source.length, so reserve
  // that widest marker before dividing the remaining room between content.
  const reservedMarkerLength = buildPreviewOmissionMarker(source.length).length;
  if (boundedMaxChars < reservedMarkerLength) {
    return '';
  }
  const retainedBudget = boundedMaxChars - reservedMarkerLength;
  const headBudget = Math.floor(retainedBudget * PREVIEW_HEAD_RATIO);
  const tailBudget = retainedBudget - headBudget;
  const rawHead = source.slice(0, headBudget);
  const head =
    rawHead.length > 0 && isHighSurrogate(rawHead.charCodeAt(rawHead.length - 1))
      ? rawHead.slice(0, -1)
      : rawHead;
  const rawTail = tailBudget > 0 ? source.slice(-tailBudget) : '';
  const tail =
    rawTail.length > 0 && isLowSurrogate(rawTail.charCodeAt(0)) ? rawTail.slice(1) : rawTail;
  const omittedChars = source.length - head.length - tail.length;
  return `${head}${buildPreviewOmissionMarker(omittedChars)}${tail}`;
}

function createBoundedPreviewOutput(params: {
  readonly maxSerializedChars: number;
  readonly maxTokens: number;
  readonly originalLength: number;
  readonly previewSource: string;
  readonly toolName: string;
}): Record<string, unknown> {
  const envelopeReserve = 512;
  const initialPreviewChars = Math.min(
    TOOL_RESULT_PREVIEW_CHARS,
    Math.max(0, params.maxSerializedChars - envelopeReserve)
  );
  const initial = buildPreviewOutput({
    ...params,
    preview: splitPreviewHeadTail(params.previewSource, initialPreviewChars),
  });
  if (stringifyJsonSafe(initial).length <= params.maxSerializedChars) {
    return initial;
  }

  // JSON escaping can expand a raw control character to six characters. Use
  // that worst-case ratio only when the readable first candidate did not fit;
  // this remains bounded work and never walks the unbounded tail.
  const empty = buildPreviewOutput({ ...params, preview: '' });
  const availableChars = Math.max(0, params.maxSerializedChars - stringifyJsonSafe(empty).length);
  return buildPreviewOutput({
    ...params,
    preview: splitPreviewHeadTail(params.previewSource, Math.floor(availableChars / 6)),
  });
}

/**
 * Resolve a per-tool transport override for the active run. Overrides are
 * ceilings authored deliberately against the (implicit) anchor window, so a
 * resolved budget AT OR ABOVE the anchor never scales them up. A resolved
 * budget BELOW the anchor (e.g. local Ollama/Gemma) scales the override down
 * by the same factor, floored at {@link TRANSPORT_TOOL_RESULT_TOKEN_FLOOR} —
 * otherwise a per-tool override like `skill`'s 6000 tokens stays fixed
 * regardless of the model, which on an 8192-token window is ~73% of the
 * entire context for one activation.
 */
function resolveOverrideTokens(override: number, scaledDefaultTokens: number | undefined): number {
  if (scaledDefaultTokens === undefined || scaledDefaultTokens >= MAX_TOOL_RESULT_TOKENS) {
    return override;
  }
  const scaleFactor = scaledDefaultTokens / MAX_TOOL_RESULT_TOKENS;
  return Math.max(TRANSPORT_TOOL_RESULT_TOKEN_FLOOR, Math.round(override * scaleFactor));
}

/** A compact per-child row keeps small identifying args; above this, drop them. */
const DELEGATION_CHILD_ARGS_MAX_SERIALIZED_CHARS = 200;

/**
 * Project a delegation (`agent-*`) result's `subAgentToolResults` to the
 * compact per-child rows the SubagentCard actually renders — toolName,
 * toolCallId, isError, and small args — dropping the raw child `result`
 * bodies BEFORE any size bounding.
 *
 * Field failure (2026-08-24): the raw list carried full child tool outputs,
 * ONE oversized entry blew the generic budget, `trimCollectionToBudget`
 * returned undefined (even a single item did not fit), and the preview
 * fallback dropped the list wholesale — so a reopened card read "Completed ·
 * 0 tool calls" for a child that did minutes of work. Nothing downstream
 * needs the raw bodies: the parent model receives only the child's answer
 * text (Mastra's delegation `toModelOutput`), and the card renders only the
 * identifying fields.
 */
function projectDelegationResultForTransport(toolName: string, output: unknown): unknown {
  if (!(toolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX) && isPlainRecordOutput(output))) {
    return output;
  }
  const list = output['subAgentToolResults'];
  if (!Array.isArray(list)) {
    return output;
  }
  const compact = list.map((entry) => {
    if (!isPlainRecordOutput(entry)) {
      return entry;
    }
    const args = entry['args'];
    const keepArgs =
      args !== undefined &&
      stringifyJsonSafe(toJsonSafe(args)).length <= DELEGATION_CHILD_ARGS_MAX_SERIALIZED_CHARS;
    return {
      ...(keepArgs ? { args } : {}),
      ...(entry['isError'] === undefined ? {} : { isError: entry['isError'] }),
      ...(typeof entry['toolCallId'] === 'string' ? { toolCallId: entry['toolCallId'] } : {}),
      ...(typeof entry['toolName'] === 'string' ? { toolName: entry['toolName'] } : {}),
    };
  });
  return { ...output, subAgentToolResults: compact };
}

export function boundToolOutputForModel(
  toolName: string,
  output: unknown,
  maxTokensOverride?: number,
  scaledDefaultTokens?: number
): BoundedToolOutput {
  const override = TOOL_RESULT_TOKEN_BUDGET_OVERRIDES[toolName];
  const maxTokens =
    maxTokensOverride ??
    (override === undefined
      ? (scaledDefaultTokens ?? MAX_TOOL_RESULT_TOKENS)
      : resolveOverrideTokens(override, scaledDefaultTokens));
  const maxSerializedChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const jsonSafeOutput = toJsonSafe(projectDelegationResultForTransport(toolName, output));
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

  return {
    output: createBoundedPreviewOutput({
      maxSerializedChars,
      maxTokens,
      originalLength: serialized.length,
      previewSource: typeof jsonSafeOutput === 'string' ? jsonSafeOutput : serialized,
      toolName,
    }),
  };
}
