import type http from 'node:http';
import {
  AssistantRequestBodyTooLargeError,
  assistantDataStreamSessions,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveDataStreamSession,
  type StreamChunk,
  sanitizeStreamChunk,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import type { AssistantProviderConfig } from './server/assistant-config';
import { resolveAssistantProviderConfig } from './server/assistant-config';
import {
  describeWebAssistantInputError,
  resolveWebAssistantChatTurn,
  resolveWebAssistantTurn,
} from './server/web-assistant-request';
import {
  InvalidWebAssistantRuntimeDataError,
  resolveWebAssistantRuntime,
} from './server/web-assistant-runtime';
import { buildWebAssistantStream } from './server/web-mastra-storage';

export type { StreamChunk };

const logger = createLogger('WebAssistantStream');
const JSON_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

type ServerResponseWithFlush = http.ServerResponse & {
  flushHeaders?: () => void;
};

function requestChunkToBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError('Assistant request body emitted a non-byte chunk.');
}

export async function readBody(
  req: http.IncomingMessage,
  bodyLimitBytes: number = DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
): Promise<string> {
  const contentLengthHeader = req.headers['content-length'];
  const contentLength = Array.isArray(contentLengthHeader)
    ? contentLengthHeader.at(-1)
    : contentLengthHeader;
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > bodyLimitBytes) {
      if (typeof req.resume === 'function') {
        req.resume();
      }
      throw new AssistantRequestBodyTooLargeError(bodyLimitBytes);
    }
  }

  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const removeListeners = (): void => {
      req.removeListener('aborted', onAborted);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const rejectRead = (error: Error, drainRemainingBody: boolean): void => {
      removeListeners();
      if (drainRemainingBody && typeof req.resume === 'function') {
        req.resume();
      }
      reject(error);
    };
    const onAborted = (): void => {
      rejectRead(new Error('Assistant request body stream was aborted.'), false);
    };
    const onData = (chunk: unknown): void => {
      let buffer: Buffer;
      try {
        buffer = requestChunkToBuffer(chunk);
      } catch (error) {
        rejectRead(
          error instanceof Error
            ? error
            : new TypeError('Assistant request body emitted an invalid chunk.'),
          true
        );
        return;
      }

      totalBytes += buffer.byteLength;
      if (totalBytes > bodyLimitBytes) {
        rejectRead(new AssistantRequestBodyTooLargeError(bodyLimitBytes), true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      removeListeners();
      resolve(Buffer.concat(chunks, totalBytes).toString('utf8'));
    };
    const onError = (error: Error): void => {
      rejectRead(error, false);
    };

    req.once('aborted', onAborted);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });
}

export async function handleChatEndpoint(
  bodyText: string,
  res: http.ServerResponse
): Promise<void> {
  let turn: ReturnType<typeof resolveWebAssistantChatTurn>;
  let stream: AsyncIterable<StreamChunk>;
  try {
    turn = resolveWebAssistantChatTurn(bodyText);
  } catch (error) {
    if (sendAssistantInputErrorResponse(res, error)) {
      return;
    }
    throw error;
  }

  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  try {
    stream = await toAiSdkStyleStream(
      turn.agentMessages,
      resolveWebAssistantRuntime(turn.payload.data, provider.apiKey)
    );
  } catch (error) {
    if (sendAssistantInputErrorResponse(res, error)) {
      return;
    }
    if (error instanceof InvalidWebAssistantRuntimeDataError) {
      sendJsonResponse(res, 400, { error: 'invalid_runtime_data', message: error.message });
      return;
    }
    logger.error('Failed to initialize chat stream', { error });
    sendJsonResponse(res, 502, {
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed',
    });
    return;
  }

  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });

  for await (const chunk of stream) {
    const safeChunk = sanitizeStreamChunk(chunk);
    res.write(`${JSON.stringify(safeChunk)}\n`);
  }

  res.end();
}

export async function handleAssistantEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyText: string
): Promise<void> {
  const lastEventId = readLastEventId(req);
  const existingSession = resolveDataStreamSession(lastEventId);
  if (existingSession) {
    const response = existingSession.createResponse(
      lastEventId ? { resumeFromEventId: lastEventId } : undefined
    );
    await streamResponse(res, response, req);
    return;
  }

  let turn: ReturnType<typeof resolveWebAssistantTurn>;
  try {
    turn = resolveWebAssistantTurn(bodyText);
  } catch (error) {
    if (sendAssistantInputErrorResponse(res, error)) {
      return;
    }
    throw error;
  }

  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (req) {
    req.on('close', onAbort);
    req.on('aborted', onAbort);
  }
  const removeAbortListeners = (): void => {
    if (req) {
      req.removeListener('close', onAbort);
      req.removeListener('aborted', onAbort);
    }
  };

  let agentStream: AsyncIterable<StreamChunk>;
  try {
    // The seam admits only explicit request metadata and resolves the trusted
    // permission policy; server-only runtime fields fail visibly.
    agentStream = await buildWebAssistantStream({
      agentMessages: turn.agentMessages,
      apiKey: provider.apiKey,
      data: turn.payload.data,
      signal: abortController.signal,
      ...(turn.toolApprovalAction ? { toolApprovalAction: turn.toolApprovalAction } : {}),
    });
  } catch (error) {
    removeAbortListeners();
    if (sendAssistantInputErrorResponse(res, error)) {
      return;
    }
    if (error instanceof InvalidWebAssistantRuntimeDataError) {
      sendJsonResponse(res, 400, { error: 'invalid_runtime_data', message: error.message });
      return;
    }
    logger.error('Failed to initialize assistant stream', { error });
    sendJsonResponse(res, 502, {
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed',
    });
    return;
  }

  const session = assistantDataStreamSessions.create(agentStream);
  const response = session.createResponse();
  try {
    await streamResponse(res, response, req);
  } finally {
    removeAbortListeners();
  }
}

export function sendAssistantStatusResponse(res: http.ServerResponse): void {
  const provider = resolveAssistantProviderConfig();
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(assistantStatusPayload(provider)));
}

function sendAssistantDisabledResponse(
  res: http.ServerResponse,
  provider: AssistantProviderConfig
): void {
  sendJsonResponse(res, 503, {
    error: 'assistant_disabled',
    reason: assistantStatusPayload(provider).reason,
  });
}

function sendAssistantInputErrorResponse(res: http.ServerResponse, error: unknown): boolean {
  const inputError = describeWebAssistantInputError(error);
  if (!inputError) {
    return false;
  }
  sendJsonResponse(res, inputError.status, inputError.payload);
  return true;
}

function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>
): void {
  res.writeHead(status, JSON_RESPONSE_HEADERS);
  res.end(JSON.stringify(payload));
}

function assistantStatusPayload(provider: AssistantProviderConfig): {
  enabled: boolean;
  reason?: string;
} {
  if (provider.enabled && provider.apiKey) {
    return { enabled: true };
  }
  return {
    enabled: false,
    reason: provider.disabledReason ?? 'missing_api_key',
  };
}

function readLastEventId(req: http.IncomingMessage): string | undefined {
  const header = req.headers['last-event-id'];
  if (!header) {
    return;
  }
  if (Array.isArray(header)) {
    return header.at(-1);
  }
  return header;
}

function writeResponseHeaders(res: http.ServerResponse, response: Response): void {
  const headersObject: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    headersObject[key] = value;
  }
  res.writeHead(response.status, headersObject);
}

function flushResponse(res: http.ServerResponse): void {
  const resWithFlush = res as ServerResponseWithFlush;
  if (typeof resWithFlush.flushHeaders === 'function') {
    resWithFlush.flushHeaders();
  }
}

async function writeChunkToResponse(value: Uint8Array, res: http.ServerResponse): Promise<void> {
  const writeResult = res.write(value);
  flushResponse(res);
  if (!writeResult) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }
}

async function pipeStreamToResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: http.ServerResponse,
  signal: AbortSignal
): Promise<void> {
  try {
    while (!(signal.aborted || res.destroyed)) {
      const { done, value } = await reader.read();
      if (done || signal.aborted || res.destroyed) {
        break;
      }
      if (value?.length > 0) {
        await writeChunkToResponse(value, res);
      }
    }
  } catch (error) {
    if (!(signal.aborted || res.destroyed)) {
      logger.error('Failed to stream assistant response', { error });
    }
  }
}

async function streamResponse(
  res: http.ServerResponse,
  response: Response,
  req?: http.IncomingMessage
): Promise<void> {
  writeResponseHeaders(res, response);

  const body = response.body as unknown as ReadableStream<Uint8Array> | null;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  const abortController = new AbortController();
  const abort = () => abortController.abort();

  if (req) {
    req.on('close', abort);
    req.on('aborted', abort);
  }

  try {
    await pipeStreamToResponse(reader, res, abortController.signal);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors
    }
    res.end();
    if (req) {
      req.removeListener('close', abort);
      req.removeListener('aborted', abort);
    }
  }
}
