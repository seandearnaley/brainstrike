import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type { ToolsInput } from '@mastra/core/agent';
import { toJsonSafe } from '../stream/json';
import {
  boundToolOutputForModel,
  MAX_MODEL_TOOL_RESULT_TOKENS,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
} from '../stream/tool-output-limits';

type ExecutableToolWithModelOutput = ToolsInput[string] & {
  readonly execute: (...args: unknown[]) => unknown;
  readonly toModelOutput?: (output: unknown) => unknown;
};

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_MODEL_OUTPUT_SERIALIZED_CHARS = MAX_MODEL_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN;

interface McpContentPart {
  readonly data?: unknown;
  readonly mimeType?: unknown;
  readonly text?: unknown;
  readonly type?: unknown;
}

interface McpMultimodalOutput {
  readonly content: readonly McpContentPart[];
  readonly hookAdditionalContext?: unknown;
}

interface ModelContentOutput {
  readonly type: 'content';
  readonly value: readonly unknown[];
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

function serializeBoundedOutput(toolName: string, output: unknown): string {
  const modelTokenBudget =
    toolName === 'skill' ? SKILL_ACTIVATION_RESULT_TOKEN_BUDGET : MAX_MODEL_TOOL_RESULT_TOKENS;
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
  const parts = content.filter((part): part is McpContentPart =>
    Boolean(part && typeof part === 'object')
  );
  if (!parts.some(isMcpMediaPart)) {
    return;
  }
  return {
    content: parts,
    ...('hookAdditionalContext' in output
      ? {
          hookAdditionalContext: (output as { hookAdditionalContext?: unknown })
            .hookAdditionalContext,
        }
      : {}),
  };
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
  const textSegments = multimodal.content
    .filter((part) => !isMcpMediaPart(part))
    .map(stringifyMcpTextPart);
  if (
    typeof multimodal.hookAdditionalContext === 'string' &&
    multimodal.hookAdditionalContext.length > 0
  ) {
    textSegments.unshift(`Post-tool context: ${multimodal.hookAdditionalContext}`);
  }
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

function createDefaultModelOutput(toolName: string, output: unknown): Record<string, unknown> {
  const projected = createMcpMultimodalModelOutput(toolName, output) ?? {
    type: 'text',
    value: serializeBoundedOutput(toolName, output),
  };
  return boundProjectedModelOutput(toolName, projected);
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
  preservedParts: readonly Record<string, unknown>[]
): Record<string, unknown> {
  const build = (value: string): ModelContentOutput => ({
    type: 'content',
    value: [...(value ? [{ text: value, type: 'text' }] : []), ...preservedParts],
  });
  const empty = build('');
  if (
    stringifyJsonSafe(maskMediaDataForMeasurement(empty)).length > MAX_MODEL_OUTPUT_SERIALIZED_CHARS
  ) {
    throw new RangeError(
      `${toolName} model projection media metadata exceeds the ${MAX_MODEL_OUTPUT_SERIALIZED_CHARS}-character budget`
    );
  }

  const full = build(text);
  if (
    stringifyJsonSafe(maskMediaDataForMeasurement(full)).length <= MAX_MODEL_OUTPUT_SERIALIZED_CHARS
  ) {
    return full as unknown as Record<string, unknown>;
  }

  const suffix = '\n[model projection truncated]';
  let low = 0;
  let high = Math.min(text.length, MAX_MODEL_OUTPUT_SERIALIZED_CHARS);
  let best = empty;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = build(`${sliceCodePoints(text, kept)}${suffix}`);
    if (
      stringifyJsonSafe(maskMediaDataForMeasurement(candidate)).length <=
      MAX_MODEL_OUTPUT_SERIALIZED_CHARS
    ) {
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
  output: ModelContentOutput
): Record<string, unknown> {
  if (
    stringifyJsonSafe(maskMediaDataForMeasurement(output)).length <=
    MAX_MODEL_OUTPUT_SERIALIZED_CHARS
  ) {
    return output as unknown as Record<string, unknown>;
  }

  const preservedParts = output.value.filter(isModelPreservedContentPart);
  const textAndUnknownParts = output.value.filter((part) => !isModelPreservedContentPart(part));
  const boundedText = serializeBoundedOutput(toolName, textAndUnknownParts);
  return fitContentTextToModelBudget(toolName, boundedText, preservedParts);
}

function boundProjectedModelOutput(toolName: string, output: unknown): Record<string, unknown> {
  if (isModelContentOutput(output)) {
    return boundContentModelOutput(toolName, output);
  }
  if (isRecord(output) && output['type'] === 'text' && typeof output['value'] === 'string') {
    if (stringifyJsonSafe(output).length <= MAX_MODEL_OUTPUT_SERIALIZED_CHARS) {
      return output;
    }
    return {
      type: 'text',
      value: serializeBoundedOutput(toolName, output['value']),
    };
  }
  if (isRecord(output) && output['type'] === 'json') {
    return {
      type: 'json',
      value: boundToolOutputForModel(toolName, output['value'], MAX_MODEL_TOOL_RESULT_TOKENS)
        .output,
    };
  }
  return {
    type: 'text',
    value: serializeBoundedOutput(toolName, output),
  };
}

function projectExistingModelOutput(
  toolName: string,
  projector: (output: unknown) => unknown,
  receiver: ExecutableToolWithModelOutput,
  output: unknown
): unknown {
  const projected = Reflect.apply(projector, receiver, [output]);
  if (
    projected &&
    (typeof projected === 'object' || typeof projected === 'function') &&
    typeof (projected as { then?: unknown }).then === 'function'
  ) {
    return Promise.resolve(projected).then((resolved) =>
      boundProjectedModelOutput(toolName, resolved)
    );
  }
  return boundProjectedModelOutput(toolName, projected);
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
        createDefaultModelOutput(originalToolName, readProjectionOutput(output)),
      writable: true,
    });
    projected[toolId] = cloned;
  }

  return projected;
}
