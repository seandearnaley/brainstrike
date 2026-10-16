import {
  isGuardedToolError,
  NATIVE_TOOL_ID,
  readMcpAppToolInvocationResult,
  readMcpTaskToolInvocationResult,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type { ToolsInput } from '@mastra/core/agent';
import { isValidationError } from '@mastra/core/tools';
import {
  isMcpMediaPart,
  type McpContentPart,
  readMcpMultimodalOutput,
} from '../mcp/mcp-multimodal-output';
import { toJsonSafe } from '../stream/json';
import {
  boundToolOutputForModel,
  decodedTextModelOutputChars,
  MAX_MODEL_TOOL_RESULT_CHAR_BUDGET,
  MAX_MODEL_TOOL_RESULT_TOKENS,
  NATIVE_SELF_BOUND_DOMAIN_MODEL_RESULT_CHAR_BUDGET,
  NATIVE_SELF_BOUND_MODEL_RESULT_CHAR_BUDGET,
  NATIVE_SELF_BOUND_MODEL_RESULT_TOKEN_BUDGET,
  NATIVE_SELF_BOUND_MODEL_RESULT_TOKENS,
  NATIVE_TOOL_RESULT_TOKEN_BUDGET,
  type ScaledToolResultBudget,
  SKILL_ACTIVATION_DOMAIN_MODEL_RESULT_CHAR_BUDGET,
  SKILL_ACTIVATION_MODEL_RESULT_CHAR_BUDGET,
  SKILL_ACTIVATION_MODEL_RESULT_TOKEN_BUDGET,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
} from '../stream/tool-output-limits';
import { HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET, readHookResultEnvelope } from '../tools/hook-runner';
import {
  readToolCallTelemetryMetadata,
  transferToolCallTelemetryMetadata,
} from './tool-call-telemetry';
import { isToolProjectionInputRejected } from './tool-projection-input-rejected';

const logger = createLogger('MastraAgent');

type ExecutableToolWithModelOutput = ToolsInput[string] & {
  readonly execute: (...args: unknown[]) => unknown;
  readonly toModelOutput?: (output: unknown) => unknown;
};

export type ModelOutputProjectionObserver = (toolName: string, output: unknown) => void;

const POST_TOOL_CONTEXT_LABEL = 'Post-tool context: ';
const POST_TOOL_CONTEXT_TRUNCATION_SUFFIX = '… [post-tool context truncated]';

interface ModelContentOutput {
  readonly type: 'content';
  readonly value: readonly unknown[];
}

export interface ModelProjectionBudget {
  readonly domainSerializedChars: number;
  readonly domainTokens: number;
  /** Token budget for bounding the RAW tool output before envelope fitting. */
  readonly rawOutputTokens: number;
  readonly totalSerializedChars: number;
  readonly totalTokens: number;
}

/**
 * BST-1219 (done; follow-up to PR #2349): fresh domain projections validate
 * against this run's exact resolved budget. Desktop producers receive and
 * self-fit against the same value, keeping producer fitting and the downstream
 * assertion in lockstep.
 */
export function buildDefaultModelProjectionBudget(
  resolved: ScaledToolResultBudget
): ModelProjectionBudget {
  return {
    domainSerializedChars: resolved.domainModelResultCharBudget,
    domainTokens: resolved.domainModelResultTokens,
    rawOutputTokens: MAX_MODEL_TOOL_RESULT_TOKENS,
    totalSerializedChars: MAX_MODEL_TOOL_RESULT_CHAR_BUDGET,
    totalTokens: MAX_MODEL_TOOL_RESULT_TOKENS,
  };
}

let activeToolResultBudget: ScaledToolResultBudget | undefined;

/**
 * The resolved budget for the synchronous custom-projector call currently on
 * this stack. Desktop's purpose-built projectors use this because Mastra's
 * `toModelOutput(output)` callback has no budget parameter and one tool object
 * can be re-projected for a persona running under a different model budget.
 *
 * This deliberately uses save/restore module state rather than async context:
 * every desktop custom projector is synchronous end-to-end, so Node cannot
 * interleave another call before the `finally` restores the previous value.
 * Async projectors remain supported by the outer projection pipeline, but they
 * must not depend on this synchronous-only context after returning a Promise.
 */
export function getActiveToolResultBudget(): ScaledToolResultBudget | undefined {
  return activeToolResultBudget;
}

function withActiveToolResultBudget<T>(budget: ScaledToolResultBudget, run: () => T): T {
  const previous = activeToolResultBudget;
  activeToolResultBudget = budget;
  try {
    return run();
  } finally {
    activeToolResultBudget = previous;
  }
}

const SKILL_MODEL_PROJECTION_BUDGET: ModelProjectionBudget = {
  domainSerializedChars: SKILL_ACTIVATION_DOMAIN_MODEL_RESULT_CHAR_BUDGET,
  domainTokens: SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
  rawOutputTokens: SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
  totalSerializedChars: SKILL_ACTIVATION_MODEL_RESULT_CHAR_BUDGET,
  totalTokens: SKILL_ACTIVATION_MODEL_RESULT_TOKEN_BUDGET,
};

const NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET: ModelProjectionBudget = {
  domainSerializedChars: NATIVE_SELF_BOUND_DOMAIN_MODEL_RESULT_CHAR_BUDGET,
  domainTokens: NATIVE_SELF_BOUND_MODEL_RESULT_TOKENS,
  // The raw guard stays at the tool's own contract: a result whose single
  // serialization exceeds NATIVE_TOOL_RESULT_CHAR_BUDGET violated its
  // self-bound and must be truncated with a visible hint. Only the envelope
  // budgets above carry the 2x re-escaping reserve.
  rawOutputTokens: NATIVE_TOOL_RESULT_TOKEN_BUDGET,
  totalSerializedChars: NATIVE_SELF_BOUND_MODEL_RESULT_CHAR_BUDGET,
  totalTokens: NATIVE_SELF_BOUND_MODEL_RESULT_TOKEN_BUDGET,
};

/**
 * Explicit, enumerated overrides keyed by canonical (pre-sanitization) tool
 * name. The native entries cover every tool that self-bounds its result to
 * NATIVE_TOOL_RESULT_CHAR_BUDGET and relies on the generic projection: their
 * carefully built results (head+tail retention, truncation hints — BST-1189)
 * must pass through unmodified instead of being replaced by the generic
 * prefix preview at the tighter default ceiling. executeCommand has its own
 * text projection since BST-1201 and reaches this map only through the
 * dispatcher fail-soft fallback, which needs the same pass-through envelope.
 * A Map, not a record, so hostile MCP tool names (`constructor`, …) cannot
 * resolve prototype members.
 */
const MODEL_PROJECTION_BUDGET_OVERRIDES: ReadonlyMap<string, ModelProjectionBudget> = new Map([
  [NATIVE_TOOL_ID.executeCommand, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.manageTaskList, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.queryDiagnostics, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.readWorkspaceDirectory, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.runPython, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.runSkillScript, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.skill, SKILL_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.skillRead, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
  [NATIVE_TOOL_ID.skillSearch, NATIVE_SELF_BOUND_MODEL_PROJECTION_BUDGET],
]);

function resolveModelProjectionBudget(
  toolName: string,
  defaultBudget: ModelProjectionBudget
): ModelProjectionBudget {
  return MODEL_PROJECTION_BUDGET_OVERRIDES.get(toolName) ?? defaultBudget;
}

function isExecutableTool(tool: unknown): tool is ExecutableToolWithModelOutput {
  return Boolean(
    tool &&
      typeof tool === 'object' &&
      typeof (tool as { execute?: unknown }).execute === 'function'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * BST-1249: Mastra's tool input/output validation failure carrier
 * (`@mastra/core` `ValidationError`: `{error: true, message, validationErrors}`)
 * is an EXPECTED result shape whenever the model mis-parameterizes a call, so
 * it routes to the generic bounded projection exactly like a guarded tool
 * error. Letting it reach a strict domain projector produced a spurious
 * error-severity `tool_model_projection_fail_soft` on every mis-parameterized
 * call (8 in the 2026-08 audit window), which polluted the anomaly signal that
 * log exists to carry.
 *
 * Detection delegates to `@mastra/core`'s own `isValidationError` predicate —
 * a hand-written structural check would silently no-op the moment Mastra
 * changed the carrier shape (review finding). The carrier reaches the
 * dispatcher either bare (the persisted tool result IS the carrier) or nested
 * under the AI-SDK result envelope (`{input, output, toolCallId}`); returns
 * the UNWRAPPED carrier so the projection serializes the validation message,
 * not an envelope whose (possibly huge) `input` would truncate the message
 * away (review finding).
 */
function readMastraToolValidationError(value: unknown): unknown {
  if (isValidationError(value)) {
    return value;
  }
  // Nested unwrap ONLY for the complete AI-SDK result envelope
  // ({input, output, toolCallId}) — a legitimate tool result that merely
  // CONTAINS an `output` field satisfying the validation predicate must keep
  // its other fields and its ordinary projection (Codex review: unwrapping on
  // `output` alone silently discarded sibling fields like `summary`).
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'input') &&
    Object.hasOwn(value, 'toolCallId') &&
    isValidationError(value['output'])
  ) {
    return value['output'];
  }
  return;
}

function stringifyJsonSafe(value: unknown): string {
  const serialized = JSON.stringify(toJsonSafe(value));
  if (serialized === undefined) {
    throw new TypeError('Tool model output could not be serialized');
  }
  return serialized;
}

function serializeBoundedOutput(
  toolName: string,
  output: unknown,
  modelTokenBudgetOverride: number | undefined,
  defaultBudget: ModelProjectionBudget
): string {
  const modelTokenBudget =
    modelTokenBudgetOverride ??
    resolveModelProjectionBudget(toolName, defaultBudget).rawOutputTokens;
  const bounded = boundToolOutputForModel(toolName, output, modelTokenBudget).output;
  if (typeof bounded === 'string') {
    return bounded;
  }
  const serialized = JSON.stringify(bounded);
  return serialized ?? String(bounded);
}

function stringifyMcpTextPart(part: McpContentPart): string {
  if (part.type === 'text') {
    return String(part.text ?? '');
  }
  const serialized = JSON.stringify(part);
  return serialized ?? String(part);
}

function createMcpMultimodalModelOutput(
  toolName: string,
  output: unknown,
  defaultBudget: ModelProjectionBudget
): Record<string, unknown> | undefined {
  const multimodal = readMcpMultimodalOutput(output);
  if (!multimodal) {
    return;
  }
  const companionTextSegments = multimodal.content
    .filter((part) => !isMcpMediaPart(part))
    .map(stringifyMcpTextPart);
  const textSegments: string[] = [];
  if (isRecord(output) && output['structuredContent'] !== undefined) {
    textSegments.push(`Structured content: ${stringifyJsonSafe(output['structuredContent'])}`);
  }
  textSegments.push(...companionTextSegments);
  const projectedText =
    textSegments.length > 0
      ? serializeBoundedOutput(toolName, textSegments.join('\n'), undefined, defaultBudget)
      : undefined;
  let textInserted = false;
  const value: Record<string, unknown>[] = [];

  for (const part of multimodal.content) {
    if (part.type === 'image' && typeof part.data === 'string') {
      value.push({
        data: part.data,
        mediaType: String(part.mimeType ?? 'image/png'),
        type: 'image-data',
      });
      continue;
    }
    if (part.type === 'audio' && typeof part.data === 'string') {
      value.push({
        data: part.data,
        mediaType: String(part.mimeType ?? 'audio/wav'),
        type: 'file-data',
      });
      continue;
    }
    if (!(textInserted || projectedText === undefined)) {
      value.push({ text: projectedText, type: 'text' });
      textInserted = true;
    }
  }
  if (!(textInserted || projectedText === undefined)) {
    value.push({ text: projectedText, type: 'text' });
  }
  return { type: 'content', value };
}

function createDefaultModelOutput(
  toolName: string,
  output: unknown,
  defaultBudget: ModelProjectionBudget,
  domainBudget = false
): Record<string, unknown> {
  const budget = resolveModelProjectionBudget(toolName, defaultBudget);
  const projected = createMcpMultimodalModelOutput(toolName, output, defaultBudget) ?? {
    type: 'text',
    value: serializeBoundedOutput(toolName, output, undefined, defaultBudget),
  };
  const tokenBudget = domainBudget ? budget.domainTokens : budget.totalTokens;
  const serializedCharBudget = domainBudget
    ? budget.domainSerializedChars
    : budget.totalSerializedChars;
  return boundProjectedModelOutput(
    toolName,
    projected,
    tokenBudget,
    serializedCharBudget,
    defaultBudget
  );
}

/** Consult the actual generic projection before deciding whether MCP data can stay inline. */
export function wouldTruncateMcpModelOutput(
  toolName: string,
  output: unknown,
  resolvedToolResultBudget: ScaledToolResultBudget
): boolean {
  const envelope = readHookResultEnvelope(output);
  const source = envelope ? envelope.result : output;
  const appResult = readMcpAppToolInvocationResult(source);
  const domainOutput = appResult ? appResult.result : source;
  // Tasks have a purpose-built status projection; media has its own inline contract.
  if (readMcpTaskToolInvocationResult(domainOutput) || readMcpMultimodalOutput(domainOutput)) {
    return false;
  }
  const completeText =
    typeof domainOutput === 'string' ? domainOutput : stringifyJsonSafe(domainOutput);
  const projected = createDefaultModelOutput(
    toolName,
    domainOutput,
    buildDefaultModelProjectionBudget(resolvedToolResultBudget),
    Boolean(envelope?.additionalContext)
  );
  return projected['type'] !== 'text' || projected['value'] !== completeText;
}

function isModelContentOutput(output: unknown): output is ModelContentOutput {
  return isRecord(output) && output['type'] === 'content' && Array.isArray(output['value']);
}

function isModelPreservedContentPart(part: unknown): part is Record<string, unknown> {
  if (!isRecord(part)) {
    return false;
  }
  switch (part['type']) {
    case 'file-data':
    case 'image-data':
    case 'media':
      return typeof part['data'] === 'string';
    case 'file-url':
    case 'image-url':
      return typeof part['url'] === 'string';
    case 'file-id':
    case 'image-file-id':
      return typeof part['fileId'] === 'string' || isRecord(part['fileId']);
    case 'custom':
      return true;
    default:
      return false;
  }
}

function maskPreservedContentPart(part: Record<string, unknown>): Record<string, unknown> {
  if (
    (part['type'] === 'file-data' || part['type'] === 'image-data' || part['type'] === 'media') &&
    typeof part['data'] === 'string'
  ) {
    return { ...part, data: '' };
  }
  if (
    (part['type'] === 'file-url' || part['type'] === 'image-url') &&
    typeof part['url'] === 'string' &&
    part['url'].startsWith('data:')
  ) {
    const payloadOffset = part['url'].indexOf(',');
    if (payloadOffset >= 0) {
      return { ...part, url: part['url'].slice(0, payloadOffset + 1) };
    }
  }
  return part;
}

function maskMediaDataForMeasurement(output: ModelContentOutput): Record<string, unknown> {
  return {
    type: 'content',
    value: output.value.map((part) =>
      isModelPreservedContentPart(part) ? maskPreservedContentPart(part) : part
    ),
  };
}

function fitContentTextToModelBudget(
  toolName: string,
  text: string,
  preservedParts: readonly Record<string, unknown>[],
  maxSerializedChars: number
): Record<string, unknown> {
  const build = (value: string): ModelContentOutput => ({
    type: 'content',
    value: [...(value ? [{ text: value, type: 'text' }] : []), ...preservedParts],
  });
  const empty = build('');
  if (stringifyJsonSafe(maskMediaDataForMeasurement(empty)).length > maxSerializedChars) {
    throw new RangeError(
      `${toolName} model projection media metadata exceeds the ${maxSerializedChars}-character budget`
    );
  }

  const full = build(text);
  if (stringifyJsonSafe(maskMediaDataForMeasurement(full)).length <= maxSerializedChars) {
    return full as unknown as Record<string, unknown>;
  }

  const suffix = '\n[model projection truncated]';
  let low = 0;
  let high = Math.min(text.length, maxSerializedChars);
  let best = empty;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = build(`${sliceCodePoints(text, kept)}${suffix}`);
    if (stringifyJsonSafe(maskMediaDataForMeasurement(candidate)).length <= maxSerializedChars) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best as unknown as Record<string, unknown>;
}

function boundContentModelOutput(
  toolName: string,
  output: ModelContentOutput,
  modelTokenBudget: number,
  maxSerializedChars: number,
  defaultBudget: ModelProjectionBudget
): Record<string, unknown> {
  if (stringifyJsonSafe(maskMediaDataForMeasurement(output)).length <= maxSerializedChars) {
    return output as unknown as Record<string, unknown>;
  }

  const preservedParts = output.value.filter(isModelPreservedContentPart);
  const textAndUnknownParts = output.value.filter((part) => !isModelPreservedContentPart(part));
  const boundedText = serializeBoundedOutput(
    toolName,
    textAndUnknownParts,
    modelTokenBudget,
    defaultBudget
  );
  return fitContentTextToModelBudget(toolName, boundedText, preservedParts, maxSerializedChars);
}

function fitTextModelOutput(
  toolName: string,
  text: string,
  modelTokenBudget: number,
  maxSerializedChars: number,
  defaultBudget: ModelProjectionBudget
): Record<string, unknown> {
  const build = (value: string): Record<string, unknown> => ({ type: 'text', value });
  if (stringifyJsonSafe(build(text)).length <= maxSerializedChars) {
    return build(text);
  }
  const boundedText = serializeBoundedOutput(toolName, text, modelTokenBudget, defaultBudget);
  if (stringifyJsonSafe(build(boundedText)).length <= maxSerializedChars) {
    return build(boundedText);
  }
  const suffix = '\n[model projection truncated]';
  const best = findLargestFittingCandidate(
    Math.min(boundedText.length, maxSerializedChars),
    (kept) => build(`${sliceCodePoints(boundedText, kept)}${suffix}`),
    (candidate) => stringifyJsonSafe(candidate).length <= maxSerializedChars
  );
  if (!best) {
    throw new RangeError(
      `${toolName} model projection cannot fit the ${maxSerializedChars}-character budget`
    );
  }
  return best;
}

function boundProjectedModelOutput(
  toolName: string,
  output: unknown,
  modelTokenBudget: number,
  maxSerializedChars: number,
  defaultBudget: ModelProjectionBudget
): Record<string, unknown> {
  if (isModelContentOutput(output)) {
    return boundContentModelOutput(
      toolName,
      output,
      modelTokenBudget,
      maxSerializedChars,
      defaultBudget
    );
  }
  if (isRecord(output) && output['type'] === 'text' && typeof output['value'] === 'string') {
    return fitTextModelOutput(
      toolName,
      output['value'],
      modelTokenBudget,
      maxSerializedChars,
      defaultBudget
    );
  }
  if (isRecord(output) && output['type'] === 'json') {
    const projected = {
      type: 'json',
      value: boundToolOutputForModel(toolName, output['value'], modelTokenBudget).output,
    };
    if (stringifyJsonSafe(projected).length <= maxSerializedChars) {
      return projected;
    }
    return fitTextModelOutput(
      toolName,
      stringifyJsonSafe(projected['value']),
      modelTokenBudget,
      maxSerializedChars,
      defaultBudget
    );
  }
  return fitTextModelOutput(
    toolName,
    serializeBoundedOutput(toolName, output, modelTokenBudget, defaultBudget),
    modelTokenBudget,
    maxSerializedChars,
    defaultBudget
  );
}

function measureProjectedModelOutput(output: Record<string, unknown>): number {
  const measured = isModelContentOutput(output) ? maskMediaDataForMeasurement(output) : output;
  return stringifyJsonSafe(measured).length;
}

/**
 * BST-1195: the char count a domain-projection budget check must use for a
 * GENUINELY text-typed projection — one whose producer actually returned
 * `{type:'text', value}`, not a synthetic fallback (e.g. `json`-typed input
 * pre-stringified, or an unrecognized shape coerced to text) that merely
 * ENDS UP shaped like `{type:'text', ...}` after normalization. Every
 * purpose-built desktop projector in
 * `apps/desktop/src/assistant-server/*-model-projection*.ts` self-fits
 * against `decodedTextModelOutputChars`, not `JSON.stringify(...).length`
 * (see that function's doc for the full rationale). This runtime guard sits
 * directly downstream of those projectors and re-validates the SAME budget
 * constant, so it MUST measure the same way for them — otherwise a page
 * that legitimately fits the new (larger) domain budget throws here a
 * moment later because JSON-escaping makes it look oversized again (PR
 * #2334 review). Every other domain projection — `json`, `content`, and the
 * fallback-coerced case — is unaffected by BST-1195 and keeps measuring
 * full serialized size, since nothing on those paths changed how it
 * self-fits and none of them were recalibrated for a larger effective
 * budget. `useDecodedRuler` is always the caller's own
 * `isDecodedTextRuler` determination from {@link assertDomainProjectionWithinBudget}
 * — never re-derived from the candidate's shape downstream, because by the
 * time a candidate reaches {@link composeHookContextWithProjection} a
 * fallback-coerced OR json-derived candidate can be structurally
 * indistinguishable from a genuine one (both end up `type: 'text'`).
 */
function measureDomainModelOutputForBudget(
  output: Record<string, unknown>,
  useDecodedRuler: boolean
): number {
  if (useDecodedRuler && typeof output['value'] === 'string') {
    return decodedTextModelOutputChars(output['value']);
  }
  return measureProjectedModelOutput(output);
}

interface DomainProjectionAssertion {
  /** True only for a genuine `{type:'text', value}` producer output — see
   * {@link measureDomainModelOutputForBudget}. Threaded explicitly into
   * {@link composeHookContextWithProjection} rather than re-derived, since
   * `normalized.type` alone can't tell a genuine text projection apart from
   * a fallback-coerced or json-derived one. */
  readonly isDecodedTextRuler: boolean;
  readonly normalized: Record<string, unknown>;
}

export function assertDomainProjectionWithinBudget(
  toolName: string,
  output: unknown,
  budget: ModelProjectionBudget
): DomainProjectionAssertion {
  const isGenuineTextProjection =
    isRecord(output) && output['type'] === 'text' && typeof output['value'] === 'string';
  let normalized: Record<string, unknown>;
  if (isModelContentOutput(output)) {
    normalized = output as unknown as Record<string, unknown>;
  } else if (isGenuineTextProjection) {
    normalized = { type: 'text', value: (output as { value: string }).value };
  } else if (isRecord(output) && output['type'] === 'json') {
    normalized = { type: 'json', value: toJsonSafe(output['value']) };
  } else {
    normalized = {
      type: 'text',
      value: typeof output === 'string' ? output : stringifyJsonSafe(output),
    };
  }
  if (
    measureDomainModelOutputForBudget(normalized, isGenuineTextProjection) >
    budget.domainSerializedChars
  ) {
    throw new RangeError(
      `${toolName} domain model projection exceeds the ${budget.domainSerializedChars}-character budget; purpose-built projectors must self-fit complete output`
    );
  }
  return { isDecodedTextRuler: isGenuineTextProjection, normalized };
}

interface HookProjectionComposition {
  readonly build: (context: string) => Record<string, unknown>;
}

function readHookProjectionComposition(output: unknown): HookProjectionComposition {
  if (isRecord(output) && output['type'] === 'text' && typeof output['value'] === 'string') {
    const domainText = output['value'];
    return {
      build: (context) => ({
        type: 'text',
        value:
          domainText.length > 0
            ? `${domainText}\n${POST_TOOL_CONTEXT_LABEL}${context}`
            : `${POST_TOOL_CONTEXT_LABEL}${context}`,
      }),
    };
  }
  if (isModelContentOutput(output)) {
    return {
      build: (context) => ({
        type: 'content',
        value: [...output.value, { text: `${POST_TOOL_CONTEXT_LABEL}${context}`, type: 'text' }],
      }),
    };
  }
  if (isRecord(output) && output['type'] === 'json') {
    const domainText = stringifyJsonSafe(output['value']);
    return {
      build: (context) => ({
        type: 'text',
        value: `${domainText}\n${POST_TOOL_CONTEXT_LABEL}${context}`,
      }),
    };
  }
  throw new TypeError('Bounded domain projection has an unsupported output type');
}

function contextCandidate(context: string, keptCodePoints: number, truncated: boolean): string {
  const kept = sliceCodePoints(context, keptCodePoints);
  return truncated ? `${kept}${POST_TOOL_CONTEXT_TRUNCATION_SUFFIX}` : kept;
}

function findLargestFittingCandidate<T>(
  maximum: number,
  createCandidate: (kept: number) => T,
  fits: (candidate: T) => boolean
): T | undefined {
  let low = 0;
  let high = maximum;
  let best: T | undefined;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = createCandidate(kept);
    if (fits(candidate)) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best;
}

function capHookContextForProjection(context: string): string {
  const capped = sliceCodePoints(context, HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET);
  return capped.length < context.length
    ? `${capped}${POST_TOOL_CONTEXT_TRUNCATION_SUFFIX}`
    : capped;
}

function composeHookContextWithProjection(
  toolName: string,
  domainProjection: Record<string, unknown>,
  hookContext: string,
  isDecodedTextRuler: boolean,
  budget: ModelProjectionBudget
): Record<string, unknown> {
  const composition = readHookProjectionComposition(domainProjection);
  const context = capHookContextForProjection(hookContext);
  // BST-1195: `isDecodedTextRuler` comes from the caller's
  // `assertDomainProjectionWithinBudget` call, NOT re-derived here.
  // `readHookProjectionComposition`'s `json` branch also produces a
  // `type: 'text'` composed candidate (it pre-stringifies the JSON value),
  // so dispatching on the CANDIDATE's shape alone would wrongly give an
  // originally json-typed (or fallback-coerced) domain projection the
  // decoded ruler too — projections this ticket never touched or
  // recalibrated. For a genuine text projection this total-envelope check
  // stays aligned with the same decoded ruler its domain check just passed
  // (an escape-dense page that legitimately cleared the 6000-char domain
  // budget must not overflow this 8000-char total budget under the OLD
  // serialized measurement before a single byte of hook context is added);
  // every other projection keeps measuring full serialized size here
  // exactly as before.
  const fits = (candidate: Record<string, unknown>): boolean =>
    measureDomainModelOutputForBudget(candidate, isDecodedTextRuler) <= budget.totalSerializedChars;

  const full = composition.build(context);
  if (fits(full)) {
    return full;
  }
  const fittedContext = findLargestFittingCandidate(
    HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET,
    (kept) => contextCandidate(hookContext, kept, true),
    (candidate) => fits(composition.build(candidate))
  );
  if (!fittedContext) {
    throw new RangeError(
      `${toolName} model projection cannot retain its post-tool context within the ${budget.totalSerializedChars}-character budget`
    );
  }
  return composition.build(fittedContext);
}

function projectDefaultModelOutput(
  toolName: string,
  output: unknown,
  resolvedDefaultBudget: ModelProjectionBudget
): Record<string, unknown> {
  if (isGuardedToolError(output)) {
    return createDefaultModelOutput(toolName, output, resolvedDefaultBudget);
  }
  const nestedValidationError = readMastraToolValidationError(output);
  if (nestedValidationError !== undefined) {
    return createDefaultModelOutput(toolName, nestedValidationError, resolvedDefaultBudget);
  }
  const envelope = readHookResultEnvelope(output);
  const persistedDomainOutput = envelope ? envelope.result : output;
  const appResult = readMcpAppToolInvocationResult(persistedDomainOutput);
  const domainOutput = appResult ? appResult.result : persistedDomainOutput;
  const hookContext = envelope?.additionalContext;
  const freshBudget = resolveModelProjectionBudget(toolName, resolvedDefaultBudget);
  const defaultProjection = createDefaultModelOutput(
    toolName,
    domainOutput,
    resolvedDefaultBudget,
    Boolean(hookContext)
  );
  if (!hookContext) {
    return defaultProjection;
  }
  // The generic/default projection path is untouched by BST-1195 (it always
  // self-fits via the serialized ruler, see createDefaultModelOutput /
  // fitTextModelOutput), so its hook-composed candidate keeps measuring
  // serialized size too: isDecodedTextRuler is always false here.
  return composeHookContextWithProjection(
    toolName,
    defaultProjection,
    hookContext,
    false,
    freshBudget
  );
}

const MAX_PROJECTION_SHAPE_KEYS = 12;
const MAX_PROJECTION_SHAPE_KEY_CHARS = 64;

/**
 * Structure-only summary of a value a domain projector rejected — key names
 * and kinds, never content (tool results can carry user data). Keys are
 * capped in count AND per-key length: record-shaped results keyed by user
 * data (paths, ids) must not stream unbounded content into the log. The
 * nested `output` keys are included because the known escape shapes differ
 * exactly there (an AI-SDK `{toolCallId, input, output}` carrier vs. a bare
 * record).
 */
function summarizeShapeKeys(record: object): string[] {
  return Object.keys(record)
    .sort()
    .slice(0, MAX_PROJECTION_SHAPE_KEYS)
    .map((key) =>
      key.length > MAX_PROJECTION_SHAPE_KEY_CHARS
        ? `${sliceCodePoints(key, MAX_PROJECTION_SHAPE_KEY_CHARS)}…`
        : key
    );
}

function summarizeProjectionValueShape(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return { kind: value === null ? 'null' : typeof value };
  }
  if (Array.isArray(value)) {
    return { kind: 'array', length: value.length };
  }
  const nestedOutput = (value as Record<string, unknown>)['output'];
  return {
    keyCount: Object.keys(value).length,
    keys: summarizeShapeKeys(value),
    kind: 'object',
    ...(isRecord(nestedOutput) ? { outputKeys: summarizeShapeKeys(nestedOutput) } : {}),
  };
}

function projectExistingModelOutput(
  toolName: string,
  projector: (output: unknown) => unknown,
  receiver: ExecutableToolWithModelOutput,
  output: unknown,
  resolvedDefaultBudget: ModelProjectionBudget,
  resolvedToolResultBudget: ScaledToolResultBudget
): unknown {
  if (isGuardedToolError(output)) {
    return projectDefaultModelOutput(toolName, output, resolvedDefaultBudget);
  }
  const validationError = readMastraToolValidationError(output);
  if (validationError !== undefined) {
    return projectDefaultModelOutput(toolName, validationError, resolvedDefaultBudget);
  }
  const envelope = readHookResultEnvelope(output);
  const persistedDomainOutput = envelope ? envelope.result : output;
  const appResult = readMcpAppToolInvocationResult(persistedDomainOutput);
  const domainOutput = appResult ? appResult.result : persistedDomainOutput;
  const hookContext = envelope?.additionalContext;
  const freshBudget = resolveModelProjectionBudget(toolName, resolvedDefaultBudget);
  const boundResolvedProjection = (resolved: unknown): unknown => {
    if (resolved === null || resolved === undefined) {
      return projectDefaultModelOutput(toolName, output, resolvedDefaultBudget);
    }
    const { isDecodedTextRuler, normalized } = assertDomainProjectionWithinBudget(
      toolName,
      resolved,
      freshBudget
    );
    if (hookContext) {
      return composeHookContextWithProjection(
        toolName,
        normalized,
        hookContext,
        isDecodedTextRuler,
        freshBudget
      );
    }
    return normalized;
  };
  // A domain projector that rejects its input's SHAPE must not kill the whole
  // run: the thrown error replaces (and destroys) the diagnostic for whatever
  // put the unexpected value here — a failed/cancelled tool, a stored
  // projection with drifted keys, or a caller convention passing a carrier
  // object (all observed 2026-08-03, BST-1096 follow-up). Degrade to the
  // generic bounded projection and log the value's SHAPE so the trigger
  // identifies itself. ONLY the explicit `ToolProjectionInputRejectedError`
  // marker degrades: every other projector throw is deliberate contract
  // enforcement (continuation-guidance invariants, self-fit budget guards)
  // and keeps failing the run, as does `boundResolvedProjection`'s budget
  // contract for projectors that RETURN an oversized value.
  const failSoft = (error: unknown): unknown => {
    if (!isToolProjectionInputRejected(error)) {
      throw error;
    }
    logger.error('Tool model projection rejected its input; degrading to the generic projection', {
      code: 'tool_model_projection_fail_soft',
      error: error instanceof Error ? error.message : String(error),
      toolName,
      valueShape: summarizeProjectionValueShape(domainOutput),
    });
    return projectDefaultModelOutput(toolName, output, resolvedDefaultBudget);
  };
  let projected: unknown;
  try {
    projected = withActiveToolResultBudget(resolvedToolResultBudget, () =>
      Reflect.apply(projector, receiver, [domainOutput])
    );
  } catch (error) {
    return failSoft(error);
  }
  if (
    projected &&
    (typeof projected === 'object' || typeof projected === 'function') &&
    typeof (projected as { then?: unknown }).then === 'function'
  ) {
    return Promise.resolve(projected).then(boundResolvedProjection, failSoft);
  }
  return boundResolvedProjection(projected);
}

function observeModelOutput(
  toolName: string,
  output: unknown,
  observer: ModelOutputProjectionObserver | undefined,
  telemetrySource: unknown
): unknown {
  if (!observer) {
    return output;
  }
  if (
    output &&
    (typeof output === 'object' || typeof output === 'function') &&
    typeof (output as { then?: unknown }).then === 'function'
  ) {
    return Promise.resolve(output).then((resolved) => {
      transferToolCallTelemetryMetadata(telemetrySource, resolved);
      observer(toolName, resolved);
      return resolved;
    });
  }
  transferToolCallTelemetryMetadata(telemetrySource, output);
  observer(toolName, output);
  return output;
}

function readTelemetrySource(output: unknown): unknown {
  const envelope = readHookResultEnvelope(output);
  const domainOutput = envelope ? envelope.result : output;
  return readToolCallTelemetryMetadata(domainOutput) ? domainOutput : output;
}

/**
 * Give every execute-backed tool a Mastra-native model projection while keeping
 * its raw execution result intact for persistence and application consumers.
 *
 * Existing tool-specific projections remain authoritative but are composed
 * with the same final text ceiling. Model-native inline media is preserved.
 * The generic projection is the safety net for native and MCP tools that do
 * not yet define a more concise, domain-specific representation.
 */
export function applyToolModelOutputProjections(
  tools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>,
  observer: ModelOutputProjectionObserver | undefined,
  resolvedToolResultBudget: ScaledToolResultBudget
): ToolsInput {
  const resolvedDefaultBudget = buildDefaultModelProjectionBudget(resolvedToolResultBudget);
  const projected: ToolsInput = {};

  for (const [toolId, tool] of Object.entries(tools)) {
    if (!isExecutableTool(tool)) {
      projected[toolId] = tool;
      continue;
    }

    const originalToolName = toolNameMap.get(toolId) ?? toolId;
    const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableToolWithModelOutput;
    Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));

    if (tool.toModelOutput !== undefined) {
      if (typeof tool.toModelOutput !== 'function') {
        throw new TypeError(`${toolId} declares a non-callable toModelOutput`);
      }
      const originalProjection = tool.toModelOutput;
      Object.defineProperty(cloned, 'toModelOutput', {
        configurable: true,
        enumerable: true,
        value: (output: unknown) =>
          observeModelOutput(
            originalToolName,
            projectExistingModelOutput(
              originalToolName,
              originalProjection,
              cloned,
              output,
              resolvedDefaultBudget,
              resolvedToolResultBudget
            ),
            observer,
            readTelemetrySource(output)
          ),
        writable: true,
      });
      projected[toolId] = cloned;
      continue;
    }

    Object.defineProperty(cloned, 'toModelOutput', {
      configurable: true,
      enumerable: true,
      value: (output: unknown) =>
        observeModelOutput(
          originalToolName,
          projectDefaultModelOutput(originalToolName, output, resolvedDefaultBudget),
          observer,
          readTelemetrySource(output)
        ),
      writable: true,
    });
    projected[toolId] = cloned;
  }

  return projected;
}
