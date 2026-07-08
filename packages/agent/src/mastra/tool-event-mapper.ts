import { isGuardedToolError } from '../tools/guard-tool-execution';
import type { StreamChunk } from '../types';

type ToolEventPart = {
  type: string;
  payload?: Record<string, unknown>;
} & Record<string, unknown>;

const PROGRESS_START_STEP = 'input_stream_start';
const PROGRESS_END_STEP = 'input_stream_end';

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
    case 'tool-error': {
      const error =
        readMastraStreamPartValue(candidate, 'error') ??
        readMastraStreamPartValue(candidate, 'result');
      return {
        name: displayName,
        payload: {
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
      return;
  }
}

function mapToolResultEvent(
  candidate: ToolEventPart,
  displayName: string,
  callId: string | undefined
): StreamChunk {
  const result =
    readMastraStreamPartValue(candidate, 'result') ??
    readMastraStreamPartValue(candidate, 'output');
  const errorResult =
    readMastraStreamPartValue(candidate, 'isError') === true || isGuardedToolError(result);
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
