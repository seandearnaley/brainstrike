import {
  DECLINED_TOOL_RESULT_KIND,
  type DeclinedToolCallResult,
} from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/logging';
import {
  getTransformedToolPayload,
  hasTransformedToolPayload,
  type ToolPayloadTransformPhase,
} from '@mastra/core/tools';
import { formatDiagnosticChunkType } from '../stream/diagnostic-chunk-type';
import { isGuardedToolError } from '../tools/guard-tool-execution';
import { readHookResultEnvelope } from '../tools/hook-runner';
import type { StreamChunk } from '../types';

type ToolEventPart = {
  type: string;
  payload?: Record<string, unknown>;
} & Record<string, unknown>;

const PROGRESS_START_STEP = 'input_stream_start';
const PROGRESS_END_STEP = 'input_stream_end';
export const TOOL_CALL_DECLINED_MESSAGE =
  'The user declined this tool call, so it was not executed.';
const logger = createLogger('MastraToolEventMapper');

export function mapMastraToolEvent(
  candidate: unknown,
  toolNames: Map<string, string>,
  sanitizedNames?: Map<string, string>
): StreamChunk | undefined {
  if (!isToolEventPart(candidate)) {
    return;
  }

  const callId =
    readMastraStreamPartString(candidate, 'toolCallId') ??
    readMastraStreamPartString(candidate, 'id');
  const rawToolName = resolveRawToolName(candidate, callId, toolNames);
  const displayName = rawToolName
    ? (sanitizedNames?.get(rawToolName) ?? rawToolName)
    : 'unknown-tool';

  switch (candidate.type) {
    case 'tool-call': {
      if (callId && rawToolName) {
        toolNames.set(callId, rawToolName);
      }
      const args = readMastraStreamPartValue(candidate, 'args');
      return {
        name: displayName,
        payload: {
          args,
          callId,
          dynamic: readMastraStreamPartValue(candidate, 'dynamic'),
          error: readMastraStreamPartValue(candidate, 'error'),
          input: args,
          invalid: readMastraStreamPartValue(candidate, 'invalid'),
          providerExecuted: readMastraStreamPartValue(candidate, 'providerExecuted'),
          toolCallId: callId,
        },
        status: 'start',
        type: 'tool-event',
      } satisfies StreamChunk;
    }
    case 'tool-call-input-streaming-start': {
      return progressEvent(displayName, callId, {
        providerExecuted: readMastraStreamPartValue(candidate, 'providerExecuted'),
        step: PROGRESS_START_STEP,
      });
    }
    case 'tool-call-delta': {
      const delta =
        readMastraStreamPartString(candidate, 'argsTextDelta') ??
        readMastraStreamPartString(candidate, 'textDelta');
      const note = delta?.trim();
      return progressEvent(displayName, callId, {
        step: 'input_stream_delta',
        ...(note ? { note } : {}),
        argsTextDelta: delta,
      });
    }
    case 'tool-call-input-streaming-end': {
      return progressEvent(displayName, callId, {
        step: PROGRESS_END_STEP,
      });
    }
    case 'tool-result': {
      return mapToolResultEvent(candidate, displayName, callId);
    }
    case 'tool-output': {
      return mapToolOutputEvent(candidate, displayName, callId);
    }
    case 'tool-output-denied': {
      // @mastra/core 1.59 `ToolOutputDeniedPayload`:
      // `{ toolCallId, toolName, args?, approval: { id, approved: false, reason? } }`.
      // Mapped as the DECLINE terminal (`status: 'declined'`) so the call
      // RESOLVES downstream — a declined call left pending is the hang mastra
      // #20886 shipped this chunk to fix. Deliberately NOT `'error'`: routing a
      // decline through the error path queues the visible "I couldn't complete
      // the tool action because it failed" fallback and marks the step errored
      // whenever the model adds no text after the denial, which is false. Same
      // ruling the BST-558 resume-unsupported terminal already settled (see
      // docs/agents/assistant-runtime.md, "The tool card is SETTLED").
      //
      // The result is the SHARED `DeclinedToolCallResult` envelope, not a bare
      // string: the envelope is what lets a tool card pick the muted declined
      // treatment instead of inventing a Completed or a Failed, and it carries
      // the user's reason to consumers on the wire instead of stranding it in a
      // package-local flag no frame forwards. Model-safe by construction — only
      // the decision and the user's own optional words, never tool internals.
      const approval = readMastraStreamPartValue(candidate, 'approval');
      const reason = readMastraStreamPartString(approval, 'reason');
      const result: DeclinedToolCallResult = {
        kind: DECLINED_TOOL_RESULT_KIND,
        message: TOOL_CALL_DECLINED_MESSAGE,
        ...(reason ? { reason } : {}),
      };
      return {
        name: displayName,
        payload: {
          args: readMastraStreamPartValue(candidate, 'args'),
          callId,
          result,
          toolCallId: callId,
        },
        status: 'declined',
        type: 'tool-event',
      } satisfies StreamChunk;
    }
    case 'tool-error': {
      const error =
        readMastraStreamPartValue(candidate, 'error') ??
        readMastraStreamPartValue(candidate, 'result');
      return {
        name: displayName,
        payload: {
          args: readMastraStreamPartValue(candidate, 'args'),
          callId,
          dynamic: readMastraStreamPartValue(candidate, 'dynamic'),
          error,
          providerExecuted: readMastraStreamPartValue(candidate, 'providerExecuted'),
          toolCallId: callId,
        },
        status: 'error',
        type: 'tool-event',
      } satisfies StreamChunk;
    }
    default:
      logger.warn('mastra tool event mapper received an unrecognized chunk', {
        chunkType: formatDiagnosticChunkType(candidate.type),
        code: 'mastra_tool_event_unrecognized_stream_chunk',
      });
      return;
  }
}

/** Root and delegated results share display transforms and guarded-error classification. */
function readToolResult(candidate: ToolEventPart): { result: unknown; isError: boolean } {
  const rawResult =
    readMastraStreamPartValue(candidate, 'result') ??
    readMastraStreamPartValue(candidate, 'output');
  const result = readDisplayToolPayload(candidate, 'output-available', rawResult);
  return {
    isError: readMastraStreamPartValue(candidate, 'isError') === true || isGuardedToolError(result),
    result,
  };
}

function mapToolResultEvent(
  candidate: ToolEventPart,
  displayName: string,
  callId: string | undefined
): StreamChunk {
  const { result, isError: errorResult } = readToolResult(candidate);
  return {
    name: displayName,
    payload: {
      callId,
      toolCallId: callId,
      ...(errorResult ? { error: result } : { output: result }),
      args: readMastraStreamPartValue(candidate, 'args'),
      dynamic: readMastraStreamPartValue(candidate, 'dynamic'),
      isError: errorResult,
      preliminary: readMastraStreamPartValue(candidate, 'preliminary'),
      providerExecuted: readMastraStreamPartValue(candidate, 'providerExecuted'),
      result,
    },
    status: errorResult ? 'error' : 'success',
    type: 'tool-event',
  } satisfies StreamChunk;
}

function mapToolOutputEvent(
  candidate: ToolEventPart,
  displayName: string,
  callId: string | undefined
): StreamChunk {
  const output = readMastraStreamPartValue(candidate, 'output');
  const guardedError = isGuardedToolError(output);
  return {
    name: displayName,
    payload: {
      callId,
      toolCallId: callId,
      ...(guardedError ? { error: output } : { output }),
      dynamic: readMastraStreamPartValue(candidate, 'dynamic'),
      providerExecuted: readMastraStreamPartValue(candidate, 'providerExecuted'),
    },
    status: guardedError ? 'error' : 'success',
    type: 'tool-event',
  } satisfies StreamChunk;
}

function readDisplayToolPayload(
  candidate: ToolEventPart,
  phase: ToolPayloadTransformPhase,
  fallback: unknown
): unknown {
  const metadata = readMastraStreamPartValue(candidate, 'metadata');
  const transformed = getTransformedToolPayload(metadata, 'display', phase);
  const value = hasTransformedToolPayload(transformed) ? transformed.transformed : fallback;
  const envelope = readHookResultEnvelope(value);
  if (!envelope) {
    return value;
  }
  return envelope.result;
}

function progressEvent(
  name: string,
  callId: string | undefined,
  payload: Record<string, unknown>
): StreamChunk {
  return {
    name,
    payload: {
      callId,
      toolCallId: callId,
      ...payload,
    },
    status: 'progress',
    type: 'tool-event',
  } satisfies StreamChunk;
}

function resolveRawToolName(
  part: ToolEventPart,
  callId: string | undefined,
  toolNames: Map<string, string>
): string | undefined {
  const explicitName =
    readMastraStreamPartString(part, 'toolName') ?? readMastraStreamPartString(part, 'name');
  if (explicitName) {
    if (callId) {
      toolNames.set(callId, explicitName);
    }
    return explicitName;
  }

  if (callId) {
    return toolNames.get(callId);
  }

  const payloadTool = readMastraStreamPartValue(part, 'tool');
  if (payloadTool && typeof payloadTool === 'object') {
    const maybeName = readMastraStreamPartString(payloadTool as Record<string, unknown>, 'name');
    if (maybeName) {
      return maybeName;
    }
  }
  return;
}

export function readMastraStreamPartValue(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') {
    return;
  }

  if (key in source) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined) {
      return value;
    }
  }
  const payload = (source as { payload?: unknown }).payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (key in record && record[key] !== undefined) {
      return record[key];
    }
  }
  return;
}

export function readMastraStreamPartString(source: unknown, key: string): string | undefined {
  const value = readMastraStreamPartValue(source, key);
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return;
}

function isToolEventPart(candidate: unknown): candidate is ToolEventPart {
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { type?: unknown }).type === 'string'
  );
}

/**
 * The subset of a nested child chunk (carried inside a delegation `tool-output`
 * part's `payload.output`) the subagent stream mapper needs. Pure reader,
 * exported for unit tests.
 */
export interface NestedToolOutputChunkInfo {
  isError: boolean;
  toolCallId?: string;
  toolName?: string;
  type: string;
}

/**
 * Read the nested child chunk from a delegation `tool-output` part.
 *
 * A delegation `tool-output` part is shaped
 * `{ type:'tool-output', payload:{ toolCallId, toolName, output: <nested chunk> } }`
 * where `output` is itself a `ChunkType` (e.g. `{ type:'tool-call', payload:{
 * toolCallId, toolName, args } }`). Returns `undefined` when there is no nested
 * chunk object.
 */
export function readNestedToolOutputChunk(part: unknown): NestedToolOutputChunkInfo | undefined {
  const output = readMastraStreamPartValue(part, 'output');
  if (!output || typeof output !== 'object') {
    return;
  }
  const type = readMastraStreamPartString(output, 'type');
  if (!type) {
    return;
  }
  const toolCallId = readMastraStreamPartString(output, 'toolCallId');
  const toolName = readMastraStreamPartString(output, 'toolName');
  return {
    isError:
      type === 'tool-result' && isToolEventPart(output)
        ? readToolResult(output).isError
        : readMastraStreamPartValue(output, 'isError') === true,
    type,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
  };
}
