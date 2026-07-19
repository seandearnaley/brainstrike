import { isGuardedToolError } from '@brainstrike/assistant-contract';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type { ToolsInput } from '@mastra/core/agent';
import { toJsonSafe } from '../stream/json';
import {
  boundToolOutputForModel,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS,
  MAX_MODEL_TOOL_RESULT_CHAR_BUDGET,
  MAX_MODEL_TOOL_RESULT_TOKENS,
  SKILL_ACTIVATION_DOMAIN_MODEL_RESULT_CHAR_BUDGET,
  SKILL_ACTIVATION_MODEL_RESULT_CHAR_BUDGET,
  SKILL_ACTIVATION_MODEL_RESULT_TOKEN_BUDGET,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
} from '../stream/tool-output-limits';
import { HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET, readHookResultEnvelope } from '../tools/hook-runner';

type ExecutableToolWithModelOutput = ToolsInput[string] & {
  readonly execute: (...args: unknown[]) => unknown;
  readonly toModelOutput?: (output: unknown) => unknown;
};

const POST_TOOL_CONTEXT_LABEL = 'Post-tool context: ';
const POST_TOOL_CONTEXT_TRUNCATION_SUFFIX = '… [post-tool context truncated]';

interface McpContentPart {
  readonly data?: unknown;
  readonly mimeType?: unknown;
  readonly text?: unknown;
  readonly type?: unknown;
}

interface McpMultimodalOutput {
  readonly content: readonly McpContentPart[];
}

interface ModelContentOutput {
  readonly type: 'content';
  readonly value: readonly unknown[];
}

interface ModelProjectionBudget {
  readonly domainSerializedChars: number;
  readonly domainTokens: number;
  readonly totalSerializedChars: number;
  readonly totalTokens: number;
}

const DEFAULT_MODEL_PROJECTION_BUDGET: ModelProjectionBudget = {
  domainSerializedChars: MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  domainTokens: MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS,
  totalSerializedChars: MAX_MODEL_TOOL_RESULT_CHAR_BUDGET,
  totalTokens: MAX_MODEL_TOOL_RESULT_TOKENS,
};

const SKILL_MODEL_PROJECTION_BUDGET: ModelProjectionBudget = {
  domainSerializedChars: SKILL_ACTIVATION_DOMAIN_MODEL_RESULT_CHAR_BUDGET,
  domainTokens: SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
  totalSerializedChars: SKILL_ACTIVATION_MODEL_RESULT_CHAR_BUDGET,
  totalTokens: SKILL_ACTIVATION_MODEL_RESULT_TOKEN_BUDGET,
};

function resolveModelProjectionBudget(toolName: string): ModelProjectionBudget {
  return toolName === 'skill' ? SKILL_MODEL_PROJECTION_BUDGET : DEFAULT_MODEL_PROJECTION_BUDGET;
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

function readProjectionOutput(value: unknown): unknown {
  if (
    !isRecord(value) ||
    typeof value['toolCallId'] !== 'string' ||
    !Object.hasOwn(value, 'input') ||
    !Object.hasOwn(value, 'output')
  ) {
    return value;
  }
  const keys = Object.keys(value);
  const isMastraEnvelope =
    keys.length === 3 &&
    keys.every((key) => key === 'input' || key === 'output' || key === 'toolCallId');
  return isMastraEnvelope ? value['output'] : value;
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
  modelTokenBudgetOverride?: number
): string {
  const modelTokenBudget =
    modelTokenBudgetOverride ??
    (toolName === 'skill' ? SKILL_ACTIVATION_RESULT_TOKEN_BUDGET : MAX_MODEL_TOOL_RESULT_TOKENS);
  const bounded = boundToolOutputForModel(toolName, output, modelTokenBudget).output;
  if (typeof bounded === 'string') {
    return bounded;
  }
  const serialized = JSON.stringify(bounded);
  return serialized ?? String(bounded);
}

function isMcpMediaPart(part: McpContentPart): boolean {
  return (part.type === 'image' || part.type === 'audio') && typeof part.data === 'string';
}

export function readMcpMultimodalOutput(output: unknown): McpMultimodalOutput | undefined {
  if (!(output && typeof output === 'object')) {
    return;
  }
  const content = (output as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const parts = content.filter((part): part is McpContentPart => isRecord(part));
  if (!parts.some(isMcpMediaPart)) {
    return;
  }
  if (parts.length !== content.length) {
    throw new TypeError('MCP multimodal content must contain only object parts');
  }
  return { content: parts };
}

export function measureMcpMultimodalOutput(output: unknown):
  | {
      readonly mediaDataChars: number;
      readonly nonMediaSerializedChars: number;
    }
  | undefined {
  const multimodal = readMcpMultimodalOutput(output);
  if (!multimodal) {
    return;
  }
  let mediaDataChars = 0;
  const maskedContent = multimodal.content.map((part) => {
    if (!isMcpMediaPart(part)) {
      return part;
    }
    mediaDataChars += String(part.data).length;
    return { ...part, data: '' };
  });
  const maskedOutput = { ...(output as Record<string, unknown>), content: maskedContent };
  const serialized = JSON.stringify(maskedOutput);
  if (serialized === undefined) {
    throw new TypeError('MCP tool output could not be serialized');
  }
  return {
    mediaDataChars,
    nonMediaSerializedChars: serialized.length,
  };
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
  output: unknown
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
    textSegments.length > 0 ? serializeBoundedOutput(toolName, textSegments.join('\n')) : undefined;
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
  domainBudget = false
): Record<string, unknown> {
  const budget = resolveModelProjectionBudget(toolName);
  const projected = createMcpMultimodalModelOutput(toolName, output) ?? {
    type: 'text',
    value: serializeBoundedOutput(toolName, output),
  };
  const tokenBudget = domainBudget ? budget.domainTokens : budget.totalTokens;
  const serializedCharBudget = domainBudget
    ? budget.domainSerializedChars
    : budget.totalSerializedChars;
  return boundProjectedModelOutput(toolName, projected, tokenBudget, serializedCharBudget);
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
  maxSerializedChars: number
): Record<string, unknown> {
  if (stringifyJsonSafe(maskMediaDataForMeasurement(output)).length <= maxSerializedChars) {
    return output as unknown as Record<string, unknown>;
  }

  const preservedParts = output.value.filter(isModelPreservedContentPart);
  const textAndUnknownParts = output.value.filter((part) => !isModelPreservedContentPart(part));
  const boundedText = serializeBoundedOutput(toolName, textAndUnknownParts, modelTokenBudget);
  return fitContentTextToModelBudget(toolName, boundedText, preservedParts, maxSerializedChars);
}

function fitTextModelOutput(
  toolName: string,
  text: string,
  modelTokenBudget: number,
  maxSerializedChars: number
): Record<string, unknown> {
  const build = (value: string): Record<string, unknown> => ({ type: 'text', value });
  if (stringifyJsonSafe(build(text)).length <= maxSerializedChars) {
    return build(text);
  }
  const boundedText = serializeBoundedOutput(toolName, text, modelTokenBudget);
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
  modelTokenBudget: number = MAX_MODEL_TOOL_RESULT_TOKENS,
  maxSerializedChars: number = MAX_MODEL_TOOL_RESULT_CHAR_BUDGET
): Record<string, unknown> {
  if (isModelContentOutput(output)) {
    return boundContentModelOutput(toolName, output, modelTokenBudget, maxSerializedChars);
  }
  if (isRecord(output) && output['type'] === 'text' && typeof output['value'] === 'string') {
    return fitTextModelOutput(toolName, output['value'], modelTokenBudget, maxSerializedChars);
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
      maxSerializedChars
    );
  }
  return fitTextModelOutput(
    toolName,
    serializeBoundedOutput(toolName, output, modelTokenBudget),
    modelTokenBudget,
    maxSerializedChars
  );
}

function measureProjectedModelOutput(output: Record<string, unknown>): number {
  const measured = isModelContentOutput(output) ? maskMediaDataForMeasurement(output) : output;
  return stringifyJsonSafe(measured).length;
}

function assertDomainProjectionWithinBudget(
  toolName: string,
  output: unknown
): Record<string, unknown> {
  const budget = resolveModelProjectionBudget(toolName);
  let normalized: Record<string, unknown>;
  if (isModelContentOutput(output)) {
    normalized = output as unknown as Record<string, unknown>;
  } else if (isRecord(output) && output['type'] === 'text' && typeof output['value'] === 'string') {
    normalized = { type: 'text', value: output['value'] };
  } else if (isRecord(output) && output['type'] === 'json') {
    normalized = { type: 'json', value: toJsonSafe(output['value']) };
  } else {
    normalized = {
      type: 'text',
      value: typeof output === 'string' ? output : stringifyJsonSafe(output),
    };
  }
  if (measureProjectedModelOutput(normalized) > budget.domainSerializedChars) {
    throw new RangeError(
      `${toolName} domain model projection exceeds the ${budget.domainSerializedChars}-character budget; purpose-built projectors must self-fit complete output`
    );
  }
  return normalized;
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
  hookContext: string
): Record<string, unknown> {
  const budget = resolveModelProjectionBudget(toolName);
  const composition = readHookProjectionComposition(domainProjection);
  const context = capHookContextForProjection(hookContext);
  const fits = (candidate: Record<string, unknown>): boolean =>
    measureProjectedModelOutput(candidate) <= budget.totalSerializedChars;

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

function projectDefaultModelOutput(toolName: string, output: unknown): Record<string, unknown> {
  if (isGuardedToolError(output)) {
    return createDefaultModelOutput(toolName, output);
  }
  const envelope = readHookResultEnvelope(output);
  const domainOutput = envelope?.result ?? output;
  const hookContext = envelope?.additionalContext;
  const defaultProjection = createDefaultModelOutput(toolName, domainOutput, Boolean(hookContext));
  if (!hookContext) {
    return defaultProjection;
  }
  return composeHookContextWithProjection(toolName, defaultProjection, hookContext);
}

function projectExistingModelOutput(
  toolName: string,
  projector: (output: unknown) => unknown,
  receiver: ExecutableToolWithModelOutput,
  output: unknown
): unknown {
  if (isGuardedToolError(output)) {
    return projectDefaultModelOutput(toolName, output);
  }
  const envelope = readHookResultEnvelope(output);
  const domainOutput = envelope?.result ?? output;
  const hookContext = envelope?.additionalContext;
  const boundResolvedProjection = (resolved: unknown): unknown => {
    if (resolved === null || resolved === undefined) {
      return projectDefaultModelOutput(toolName, output);
    }
    const domainProjection = assertDomainProjectionWithinBudget(toolName, resolved);
    if (hookContext) {
      return composeHookContextWithProjection(toolName, domainProjection, hookContext);
    }
    return domainProjection;
  };
  const projected = Reflect.apply(projector, receiver, [domainOutput]);
  if (
    projected &&
    (typeof projected === 'object' || typeof projected === 'function') &&
    typeof (projected as { then?: unknown }).then === 'function'
  ) {
    return Promise.resolve(projected).then(boundResolvedProjection);
  }
  return boundResolvedProjection(projected);
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
  toolNameMap: ReadonlyMap<string, string>
): ToolsInput {
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
          projectExistingModelOutput(
            originalToolName,
            originalProjection,
            cloned,
            readProjectionOutput(output)
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
        projectDefaultModelOutput(originalToolName, readProjectionOutput(output)),
      writable: true,
    });
    projected[toolId] = cloned;
  }

  return projected;
}
