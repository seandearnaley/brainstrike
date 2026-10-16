import { readMcpAppToolInvocationResult } from '@brainstrike/assistant-contract';
import {
  encodeToolOutputArtifactContent,
  encodeToolOutputArtifactCursor,
  isToolOutputArtifactEnvelope,
  TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  type ToolOutputArtifactEnvelope,
  type ToolOutputArtifactFormat,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import { readMcpMultimodalOutput } from '../mcp/mcp-multimodal-output';
import { toJsonSafe } from '../stream/json';
import { MAX_TOOL_RESULT_TOKENS } from '../stream/tool-output-limits';
import { isGuardedToolError } from '../tools/guard-tool-execution';
import { readHookResultEnvelope } from '../tools/hook-runner';
import { projectToolOutputArtifactPage } from './tool-output-artifact-reader';

const APPROX_CHARS_PER_TOKEN = 4;
const TEXT_ENCODER = new TextEncoder();

/** Results at or below this UTF-8 byte size remain inline. */
export const TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES =
  MAX_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN;
/** Explicit upstream safety cap for one complete durable result. */
export const TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES = 16 * 1024 * 1024;

export type ToolOutputArtifactSettlementFailureReason = 'output_too_large' | 'serialization_failed';

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

export interface SerializedToolOutput {
  readonly byteLength: number;
  readonly content: string;
  readonly format: ToolOutputArtifactFormat;
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

/** One complete tool result that must settle as a durable artifact. */
export interface ToolOutputArtifactCandidate {
  /** The display-facing result (a hook envelope's inner result). */
  readonly displaySource: unknown;
  /** Present when an MCP app result must keep its renderer-owned marker. */
  readonly isAppResult: boolean;
  readonly serialized: SerializedToolOutput;
}

/**
 * The settlement decision for one complete result: undefined when it stays
 * inline (guarded errors, envelopes, multimodal output, or within every
 * inline ceiling); otherwise its exact serialized artifact content.
 */
export function toolOutputArtifactCandidate(
  output: unknown,
  toolName: string,
  options: {
    /**
     * Optional stricter inline ceilings for tools whose complete model projection
     * must fit a smaller character budget than the generic transport envelope.
     * Keys are canonical (pre-sanitization) tool names.
     */
    readonly inlineMaxSerializedCharsByToolName?: ReadonlyMap<string, number>;
    /** The model-projection owner decides whether an otherwise-inline result loses data. */
    readonly wouldTruncateModelOutput?: (toolName: string, output: unknown) => boolean;
  }
): ToolOutputArtifactCandidate | undefined {
  if (isGuardedToolError(output) || isToolOutputArtifactEnvelope(output)) {
    return;
  }
  const hookEnvelope = readHookResultEnvelope(output);
  const displaySource = hookEnvelope ? hookEnvelope.result : output;
  const appResult = readMcpAppToolInvocationResult(displaySource);
  const domainOutput = appResult ? appResult.result : displaySource;
  if (readMcpMultimodalOutput(domainOutput)) {
    return;
  }
  const serialized = serializeToolOutput(domainOutput, toolName);
  if (!serialized) {
    return;
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
    return;
  }
  if (serialized.byteLength > TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES) {
    throw new ToolOutputArtifactSettlementError('output_too_large', toolName);
  }
  return { displaySource, isAppResult: appResult !== undefined, serialized };
}

/** The bounded first page the model receives for a settled artifact. */
export function toolOutputArtifactModelOutput(input: {
  readonly content: string;
  readonly readerToolName: string;
  readonly reference: ToolOutputArtifactReference;
}): ReturnType<typeof projectToolOutputArtifactPage> {
  const { content, readerToolName, reference } = input;
  const preview = fitArtifactPreview(content);
  if (preview.endByte >= reference.byteLength) {
    return projectToolOutputArtifactPage(
      {
        artifactRef: reference,
        ...(preview.contentEncoding ? { contentEncoding: preview.contentEncoding } : {}),
        content: preview.preview,
        endByte: preview.endByte,
        offsetByte: 0,
      },
      undefined,
      readerToolName
    );
  }
  return projectToolOutputArtifactPage(
    {
      artifactRef: reference,
      ...(preview.contentEncoding ? { contentEncoding: preview.contentEncoding } : {}),
      content: preview.preview,
      endByte: preview.endByte,
      nextCursor: encodeToolOutputArtifactCursor(reference, preview.endByte),
      offsetByte: 0,
    },
    undefined,
    readerToolName
  );
}
