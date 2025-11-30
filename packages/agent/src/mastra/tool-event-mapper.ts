import type { StreamChunk } from '../index';

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

  const callId = readString(candidate, 'toolCallId') ?? readString(candidate, 'id');
  const rawToolName = resolveRawToolName(candidate, callId, toolNames);
  const displayName = rawToolName
    ? (sanitizedNames?.get(rawToolName) ?? rawToolName)
    : 'unknown-tool';

  switch (candidate.type) {
    case 'tool-call': {
      if (callId && rawToolName) {
        toolNames.set(callId, rawToolName);
      }
      const args = read(candidate, 'args');
      return {
        type: 'tool-event',
        name: displayName,
        status: 'start',
        payload: {
          callId,
          toolCallId: callId,
          args,
          input: args,
          providerExecuted: read(candidate, 'providerExecuted'),
          dynamic: read(candidate, 'dynamic'),
          invalid: read(candidate, 'invalid'),
          error: read(candidate, 'error'),
        },
      } satisfies StreamChunk;
    }
    case 'tool-call-input-streaming-start': {
      return progressEvent(displayName, callId, {
        step: PROGRESS_START_STEP,
        providerExecuted: read(candidate, 'providerExecuted'),
      });
    }
    case 'tool-call-delta': {
      const delta = readString(candidate, 'argsTextDelta') ?? readString(candidate, 'textDelta');
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
      const result = read(candidate, 'result') ?? read(candidate, 'output');
      return {
        type: 'tool-event',
        name: displayName,
        status: 'success',
        payload: {
          callId,
          toolCallId: callId,
          output: result,
          result,
          providerExecuted: read(candidate, 'providerExecuted'),
          dynamic: read(candidate, 'dynamic'),
          preliminary: read(candidate, 'preliminary'),
          args: read(candidate, 'args'),
        },
      } satisfies StreamChunk;
    }
    case 'tool-output': {
      const output = read(candidate, 'output');
      return {
        type: 'tool-event',
        name: displayName,
        status: 'success',
        payload: {
          callId,
          toolCallId: callId,
          output,
        },
      } satisfies StreamChunk;
    }
    case 'tool-error': {
      const error = read(candidate, 'error') ?? read(candidate, 'result');
      return {
        type: 'tool-event',
        name: displayName,
        status: 'error',
        payload: {
          callId,
          toolCallId: callId,
          error,
          providerExecuted: read(candidate, 'providerExecuted'),
          dynamic: read(candidate, 'dynamic'),
        },
      } satisfies StreamChunk;
    }
    default:
      return;
  }
}

function progressEvent(
  name: string,
  callId: string | undefined,
  payload: Record<string, unknown>
): StreamChunk {
  return {
    type: 'tool-event',
    name,
    status: 'progress',
    payload: {
      callId,
      toolCallId: callId,
      ...payload,
    },
  } satisfies StreamChunk;
}

function resolveRawToolName(
  part: ToolEventPart,
  callId: string | undefined,
  toolNames: Map<string, string>
): string | undefined {
  const explicitName = readString(part, 'toolName') ?? readString(part, 'name');
  if (explicitName) {
    if (callId) {
      toolNames.set(callId, explicitName);
    }
    return explicitName;
  }

  if (callId) {
    return toolNames.get(callId);
  }

  const payloadTool = read(part, 'tool');
  if (payloadTool && typeof payloadTool === 'object') {
    const maybeName = readString(payloadTool as Record<string, unknown>, 'name');
    if (maybeName) {
      return maybeName;
    }
  }

  return;
}

function read(source: ToolEventPart, key: string): unknown {
  if (source && typeof source === 'object' && key in source && source[key] !== undefined) {
    return source[key];
  }
  const payload = source.payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (key in record && record[key] !== undefined) {
      return record[key];
    }
  }
  return;
}

function readString(
  source: ToolEventPart | Record<string, unknown>,
  key: string
): string | undefined {
  const value = readValue(source, key);
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return;
}

function readValue(source: ToolEventPart | Record<string, unknown>, key: string): unknown {
  if (source && typeof source === 'object' && key in source && source[key] !== undefined) {
    return source[key];
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

function isToolEventPart(candidate: unknown): candidate is ToolEventPart {
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { type?: unknown }).type === 'string'
  );
}

// Internal utilities exposed for testing only.
/* @__PURE__ */ export const __test__ = {
  read,
  readString,
  isToolEventPart,
};
