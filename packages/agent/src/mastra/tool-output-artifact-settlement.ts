import {
  encodeToolOutputArtifactContent,
  isToolOutputArtifactEnvelope,
  isToolOutputArtifactReference,
  TOOL_OUTPUT_ARTIFACT_CODE,
  TOOL_OUTPUT_ARTIFACT_CURSOR_PREFIX,
  TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_VERSION,
  type ToolOutputArtifactEnvelope,
  type ToolOutputArtifactFormat,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type { ToolsInput } from '@mastra/core/agent';
import type {
  ToolPayloadTransform,
  ToolPayloadTransformContext,
  ToolPayloadTransformTarget,
  ToolPayloadTransformTargetConfig,
} from '@mastra/core/tools';
import { toJsonSafe } from '../stream/json';
import { MAX_TOOL_RESULT_TOKENS } from '../stream/tool-output-limits';
import { isGuardedToolError } from '../tools/guard-tool-execution';
import { readHookResultEnvelope } from '../tools/hook-runner';
import { readMcpMultimodalOutput } from './mcp-multimodal-output';

const APPROX_CHARS_PER_TOKEN = 4;
const TEXT_ENCODER = new TextEncoder();
const SETTLED_OUTPUTS = new WeakMap<object, SettledToolOutput>();

/** Results at or below this UTF-8 byte size remain inline. */
export const TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES =
  MAX_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN;
/** Explicit upstream safety cap for one complete durable result. */
export const TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES = 16 * 1024 * 1024;

export type ToolOutputArtifactSettlementFailureReason =
  | 'missing_tool_call_id'
  | 'output_too_large'
  | 'serialization_failed'
  | 'store_failed';

export class ToolOutputArtifactSettlementError extends Error {
  constructor(
    readonly reason: ToolOutputArtifactSettlementFailureReason,
    readonly toolName: string,
    cause?: unknown
  ) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Failed to settle oversized output from ${toolName} (${reason})${detail}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'ToolOutputArtifactSettlementError';
  }
}

export interface StoreSettledToolOutputInput {
  readonly content: string;
  readonly format: ToolOutputArtifactFormat;
  readonly toolCallId: string;
}

export interface ToolOutputArtifactSettlementStore {
  store(input: StoreSettledToolOutputInput): Promise<ToolOutputArtifactReference>;
}

export interface ApplyToolOutputArtifactSettlementOptions {
  readonly store: ToolOutputArtifactSettlementStore;
  readonly toolNameMap: ReadonlyMap<string, string>;
}

interface ExecutableTool {
  execute: (...args: unknown[]) => unknown;
  transform?: ToolPayloadTransform;
}

interface SerializedToolOutput {
  readonly byteLength: number;
  readonly content: string;
  readonly format: ToolOutputArtifactFormat;
}

interface SettledToolOutput {
  readonly displayOutput: ToolOutputArtifactEnvelope;
  readonly projectionSource: unknown;
}

function isExecutableTool(tool: ToolsInput[string]): tool is ToolsInput[string] & ExecutableTool {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

function serializeToolOutput(output: unknown, toolName: string): SerializedToolOutput | undefined {
  let content: string | undefined;
  let format: ToolOutputArtifactFormat;
  try {
    if (typeof output === 'string') {
      content = output;
      format = 'text';
    } else {
      content = JSON.stringify(toJsonSafe(output));
      format = 'json';
    }
  } catch (cause) {
    throw new ToolOutputArtifactSettlementError('serialization_failed', toolName, cause);
  }
  if (content === undefined) {
    return;
  }
  return {
    byteLength: TEXT_ENCODER.encode(content).byteLength,
    content,
    format,
  };
}

function readToolCallId(args: readonly unknown[]): string | undefined {
  const context = args[1];
  if (!(context && typeof context === 'object')) {
    return;
  }
  const record = context as {
    agent?: { toolCallId?: unknown };
    toolCallId?: unknown;
  };
  const candidate = record.agent?.toolCallId ?? record.toolCallId;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}

function base64UrlEncodeUtf8(value: string): string {
  const bytes = TEXT_ENCODER.encode(value);
  let binary = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/[=]+$/u, '');
}

function createContinuationCursor(
  reference: ToolOutputArtifactReference,
  offsetByte: number
): string {
  return `${TOOL_OUTPUT_ARTIFACT_CURSOR_PREFIX}${base64UrlEncodeUtf8(
    JSON.stringify([reference.id, offsetByte])
  )}`;
}

function serializedFieldByteLength(value: string): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function fitArtifactPreview(content: string): {
  readonly contentEncoding?: ToolOutputArtifactEnvelope['contentEncoding'];
  readonly endByte: number;
  readonly preview: string;
} {
  let low = 1;
  let high = Math.min(content.length, TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES);
  let best:
    | {
        readonly contentEncoding?: ToolOutputArtifactEnvelope['contentEncoding'];
        readonly endByte: number;
        readonly preview: string;
      }
    | undefined;

  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const decoded = sliceCodePoints(content, kept);
    const endByte = TEXT_ENCODER.encode(decoded).byteLength;
    const encoded = encodeToolOutputArtifactContent(decoded);
    if (
      endByte <= TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES &&
      serializedFieldByteLength(encoded.content) <= TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES
    ) {
      best = {
        ...(encoded.contentEncoding ? { contentEncoding: encoded.contentEncoding } : {}),
        endByte,
        preview: encoded.content,
      };
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }

  if (!best) {
    throw new TypeError('Tool output artifact preview could not retain one UTF-8 code point.');
  }
  return best;
}

function createArtifactEnvelope(
  toolName: string,
  reference: ToolOutputArtifactReference,
  content: string
): ToolOutputArtifactEnvelope {
  const preview = fitArtifactPreview(content);
  return {
    artifactRef: reference,
    code: TOOL_OUTPUT_ARTIFACT_CODE,
    ...(preview.contentEncoding ? { contentEncoding: preview.contentEncoding } : {}),
    hint: `The complete ${toolName} result is durable. Continue with the artifact reader using nextCursor.`,
    nextCursor: createContinuationCursor(reference, preview.endByte),
    preview: preview.preview,
    truncated: true,
    version: TOOL_OUTPUT_ARTIFACT_VERSION,
  };
}

function createSettlementCarrier(settled: SettledToolOutput): Record<string, never> {
  const carrier = {};
  SETTLED_OUTPUTS.set(carrier, settled);
  return carrier;
}

export function readSettledToolOutputProjectionSource(output: unknown): unknown {
  if (!(output && typeof output === 'object')) {
    return output;
  }
  return SETTLED_OUTPUTS.get(output)?.projectionSource ?? output;
}

function readSettledToolOutputDisplay(output: unknown): unknown {
  if (!(output && typeof output === 'object')) {
    return output;
  }
  return SETTLED_OUTPUTS.get(output)?.displayOutput ?? output;
}

function passthroughTransform(
  phase: keyof ToolPayloadTransformTargetConfig
): (context: ToolPayloadTransformContext) => unknown {
  switch (phase) {
    case 'approval':
    case 'input':
      return (context) => context.input;
    case 'error':
      return (context) => context.error;
    case 'inputDelta':
      return (context) => context.inputTextDelta;
    case 'output':
      return (context) => readSettledToolOutputDisplay(context.output);
    case 'resume':
      return (context) => context.resumeData;
    case 'suspend':
      return (context) => context.suspendPayload;
    default:
      throw new TypeError(`Unsupported tool payload transform phase: ${String(phase)}`);
  }
}

function createTargetTransform(
  existing: ToolPayloadTransformTargetConfig | undefined
): ToolPayloadTransformTargetConfig {
  const output = existing?.output;
  if (!existing) {
    return {
      approval: passthroughTransform('approval'),
      error: passthroughTransform('error'),
      input: passthroughTransform('input'),
      inputDelta: passthroughTransform('inputDelta'),
      output: passthroughTransform('output'),
      resume: passthroughTransform('resume'),
      suspend: passthroughTransform('suspend'),
    };
  }
  return {
    ...existing,
    output: (context) => {
      if (!output) {
        return;
      }
      return output({ ...context, output: readSettledToolOutputDisplay(context.output) });
    },
  };
}

function createSettlementPayloadTransform(
  existing: ToolPayloadTransform | undefined
): ToolPayloadTransform {
  const targets: readonly ToolPayloadTransformTarget[] = ['display', 'transcript'];
  return Object.fromEntries(
    targets.map((target) => [target, createTargetTransform(existing?.[target])])
  ) as ToolPayloadTransform;
}

async function settleOutput(
  output: unknown,
  args: readonly unknown[],
  toolName: string,
  store: ToolOutputArtifactSettlementStore
): Promise<unknown> {
  if (isGuardedToolError(output) || isToolOutputArtifactEnvelope(output)) {
    return output;
  }
  const hookEnvelope = readHookResultEnvelope(output);
  const domainOutput = hookEnvelope ? hookEnvelope.result : output;
  if (readMcpMultimodalOutput(domainOutput)) {
    return output;
  }
  const serialized = serializeToolOutput(domainOutput, toolName);
  if (!(serialized && serialized.byteLength > TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES)) {
    return output;
  }
  if (serialized.byteLength > TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES) {
    throw new ToolOutputArtifactSettlementError('output_too_large', toolName);
  }
  const toolCallId = readToolCallId(args);
  if (!toolCallId) {
    throw new ToolOutputArtifactSettlementError('missing_tool_call_id', toolName);
  }

  let reference: ToolOutputArtifactReference;
  try {
    reference = await store.store({
      content: serialized.content,
      format: serialized.format,
      toolCallId,
    });
  } catch (cause) {
    throw new ToolOutputArtifactSettlementError('store_failed', toolName, cause);
  }
  if (
    !isToolOutputArtifactReference(reference) ||
    reference.byteLength !== serialized.byteLength ||
    reference.format !== serialized.format
  ) {
    throw new ToolOutputArtifactSettlementError(
      'store_failed',
      toolName,
      new TypeError('Artifact storage returned incoherent metadata.')
    );
  }
  return createSettlementCarrier({
    displayOutput: createArtifactEnvelope(toolName, reference, serialized.content),
    projectionSource: output,
  });
}

/**
 * Atomically replace oversized display/transcript results with a durable
 * preview envelope while retaining the complete in-process result for
 * `toModelOutput`.
 */
export function applyToolOutputArtifactSettlement(
  tools: ToolsInput,
  options: ApplyToolOutputArtifactSettlementOptions
): ToolsInput {
  const settled: ToolsInput = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    if (!isExecutableTool(tool)) {
      settled[toolId] = tool;
      continue;
    }
    const toolName = options.toolNameMap.get(toolId) ?? toolId;
    if (toolName === 'skill') {
      settled[toolId] = tool;
      continue;
    }
    const originalExecute = tool.execute;
    const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableTool;
    Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));
    Object.defineProperty(cloned, 'transform', {
      configurable: true,
      enumerable: true,
      value: createSettlementPayloadTransform(tool.transform),
      writable: true,
    });
    cloned.execute = async (...args: unknown[]): Promise<unknown> => {
      const output = await Promise.resolve(Reflect.apply(originalExecute, cloned, args));
      return settleOutput(output, args, toolName, options.store);
    };
    settled[toolId] = cloned as ToolsInput[string];
  }
  return settled;
}
