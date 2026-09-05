import {
  NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS,
  readMcpAppToolInvocationResult,
} from '@brainstrike/assistant-contract';
import {
  encodeToolOutputArtifactContent,
  encodeToolOutputArtifactCursor,
  isToolOutputArtifactEnvelope,
  isToolOutputArtifactReference,
  TOOL_OUTPUT_ARTIFACT_CODE,
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
import { readToolCallId } from '../tools/read-tool-call-id';
import { readMcpMultimodalOutput } from './mcp-multimodal-output';
import { projectToolOutputArtifactPage } from './tool-output-artifact-reader';

const APPROX_CHARS_PER_TOKEN = 4;
const TEXT_ENCODER = new TextEncoder();
const SETTLED_OUTPUTS = new WeakMap<object, SettledToolOutput>();
const NON_DURABLE_TOOL_OUTPUT_NAMES: ReadonlySet<string> = new Set(
  NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS
);

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
  /** Delegation tools actually registered for this run, resolved after persona assembly. */
  readonly getDelegationToolNames?: () => readonly string[];
  /** Runtime registration supplies the eligible reader's exact callable name. */
  readonly getReaderToolName: () => string;
  /**
   * Optional stricter inline ceilings for tools whose complete model projection
   * must fit a smaller character budget than the generic transport envelope.
   * Keys are canonical (pre-sanitization) tool names.
   */
  readonly inlineMaxSerializedCharsByToolName?: ReadonlyMap<string, number>;
  readonly store: ToolOutputArtifactSettlementStore;
  readonly toolNameMap: ReadonlyMap<string, string>;
  /** The model-projection owner decides whether an otherwise-inline result loses data. */
  readonly wouldTruncateModelOutput?: (toolName: string, output: unknown) => boolean;
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
  readonly displayOutput: unknown;
  readonly modelOutput: ReturnType<typeof projectToolOutputArtifactPage>;
  readonly projectionSource: unknown;
}

export interface SettledToolOutputModelProjection {
  readonly hookContext?: string;
  readonly output: ReturnType<typeof projectToolOutputArtifactPage>;
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

function buildArtifactDelegationHint(delegationToolNames: readonly string[] | undefined): string {
  if (!delegationToolNames || delegationToolNames.length === 0) {
    return '';
  }
  return ` For open-ended whole-result analysis, delegate the cursor to ${delegationToolNames.join(
    ' / '
  )}.`;
}

function createArtifactOutputs(
  toolName: string,
  reference: ToolOutputArtifactReference,
  content: string,
  completeDisplayOutput: unknown,
  getDelegationToolNames: (() => readonly string[]) | undefined,
  readerToolName: string
): Pick<SettledToolOutput, 'displayOutput' | 'modelOutput'> {
  const preview = fitArtifactPreview(content);
  if (preview.endByte >= reference.byteLength) {
    return {
      displayOutput: completeDisplayOutput,
      modelOutput: projectToolOutputArtifactPage(
        {
          artifactRef: reference,
          ...(preview.contentEncoding ? { contentEncoding: preview.contentEncoding } : {}),
          content: preview.preview,
          endByte: preview.endByte,
          offsetByte: 0,
        },
        undefined,
        readerToolName
      ),
    };
  }
  const nextCursor = encodeToolOutputArtifactCursor(reference, preview.endByte);
  const delegationHint = buildArtifactDelegationHint(getDelegationToolNames?.());
  const displayOutput: ToolOutputArtifactEnvelope = {
    artifactRef: reference,
    code: TOOL_OUTPUT_ARTIFACT_CODE,
    ...(preview.contentEncoding ? { contentEncoding: preview.contentEncoding } : {}),
    hint: `The complete ${toolName} result is durable. Search with pattern or continue paging via ${readerToolName} using {"cursor":nextCursor}.${delegationHint}`,
    nextCursor,
    preview: preview.preview,
    truncated: true,
    version: TOOL_OUTPUT_ARTIFACT_VERSION,
  };
  const modelOutput = projectToolOutputArtifactPage(
    {
      artifactRef: reference,
      ...(preview.contentEncoding ? { contentEncoding: preview.contentEncoding } : {}),
      content: preview.preview,
      endByte: preview.endByte,
      nextCursor,
      offsetByte: 0,
    },
    undefined,
    readerToolName
  );
  return { displayOutput, modelOutput };
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

export function readSettledToolOutputModelProjection(
  output: unknown
): SettledToolOutputModelProjection | undefined {
  if (!(output && typeof output === 'object')) {
    return;
  }
  const settled = SETTLED_OUTPUTS.get(output);
  if (!settled) {
    return;
  }
  const hookEnvelope = readHookResultEnvelope(settled.projectionSource);
  return {
    ...(hookEnvelope?.additionalContext ? { hookContext: hookEnvelope.additionalContext } : {}),
    output: settled.modelOutput,
  };
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
  options: ApplyToolOutputArtifactSettlementOptions
): Promise<unknown> {
  if (isGuardedToolError(output) || isToolOutputArtifactEnvelope(output)) {
    return output;
  }
  const hookEnvelope = readHookResultEnvelope(output);
  const displaySource = hookEnvelope ? hookEnvelope.result : output;
  const appResult = readMcpAppToolInvocationResult(displaySource);
  const domainOutput = appResult ? appResult.result : displaySource;
  if (readMcpMultimodalOutput(domainOutput)) {
    return output;
  }
  const serialized = serializeToolOutput(domainOutput, toolName);
  if (!serialized) {
    return output;
  }
  const inlineMaxSerializedChars = options.inlineMaxSerializedCharsByToolName?.get(toolName);
  const exceedsToolCharacterLimit =
    inlineMaxSerializedChars !== undefined && serialized.content.length > inlineMaxSerializedChars;
  if (
    !(
      exceedsToolCharacterLimit ||
      serialized.byteLength > TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES ||
      options.wouldTruncateModelOutput?.(toolName, output)
    )
  ) {
    return output;
  }
  if (serialized.byteLength > TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES) {
    throw new ToolOutputArtifactSettlementError('output_too_large', toolName);
  }
  const toolCallId = readToolCallId(args);
  if (!toolCallId) {
    throw new ToolOutputArtifactSettlementError('missing_tool_call_id', toolName);
  }

  const readerToolName = options.getReaderToolName();
  let reference: ToolOutputArtifactReference;
  try {
    reference = await options.store.store({
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
  const artifactOutputs = createArtifactOutputs(
    toolName,
    reference,
    serialized.content,
    displaySource,
    options.getDelegationToolNames,
    readerToolName
  );
  return createSettlementCarrier({
    ...artifactOutputs,
    // Apps need their origin and complete result to mount and hydrate the sandbox.
    // The model pages only the ordinary result, never this renderer-owned marker.
    displayOutput: appResult ? displaySource : artifactOutputs.displayOutput,
    projectionSource: output,
  });
}

/**
 * Atomically replace oversized display/transcript results with a durable
 * preview envelope while retaining the complete in-process result for
 * authenticated lifecycle handling. Model projection receives the bounded
 * durable envelope so it can continue through the artifact reader.
 */
export function applyToolOutputArtifactSettlement(
  tools: ToolsInput,
  options: ApplyToolOutputArtifactSettlementOptions
): ToolsInput {
  for (const [toolName, maxChars] of options.inlineMaxSerializedCharsByToolName ??
    new Map<string, number>()) {
    if (!(Number.isSafeInteger(maxChars) && maxChars > 0)) {
      throw new TypeError(
        `Invalid tool output artifact inline character limit for ${toolName}: ${maxChars}`
      );
    }
  }
  const settled: ToolsInput = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    if (!isExecutableTool(tool)) {
      settled[toolId] = tool;
      continue;
    }
    const toolName = options.toolNameMap.get(toolId) ?? toolId;
    if (toolName === 'skill' || NON_DURABLE_TOOL_OUTPUT_NAMES.has(toolName)) {
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
      return settleOutput(output, args, toolName, options);
    };
    settled[toolId] = cloned as ToolsInput[string];
  }
  return settled;
}
