import type http from 'node:http';
import {
  AssistantRequestBodyTooLargeError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  type StreamChunk,
  sanitizeStreamChunk,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createStatelessAssistantDataStreamResponse } from '@brainstrike/agent/hosted-web';
import { createLogger } from '@brainstrike/utils/logger';
import type { AssistantProviderConfig } from './server/assistant-config';
import {
  HOSTED_WEB_ASSISTANT_PROVIDER,
  resolveAssistantProviderConfig,
  resolveHostedWebAssistantModel,
} from './server/assistant-config';
import {
  describeWebAssistantInputError,
  resolveWebAssistantChatTurn,
  resolveWebAssistantTurn,
  WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE,
  WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE,
} from './server/web-assistant-request';
import {
  InvalidWebAssistantRuntimeDataError,
  resolveWebAssistantRuntime,
} from './server/web-assistant-runtime';
import { buildWebAssistantStream } from './server/web-assistant-stream';

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
    sendJsonResponse(
      res,
      WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.status,
      WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.payload
    );
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
  if (lastEventId) {
    sendJsonResponse(res, 409, WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE);
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
  if (turn.toolApprovalAction) {
    sendJsonResponse(res, 409, {
      error: 'tool_approval_unavailable',
      message: 'Hosted Web tool approval requires durable workflow storage.',
    });
    return;
  }
  if (turn.toolResumeAction) {
    sendJsonResponse(res, 409, {
      error: 'tool_resume_unavailable',
      message: 'Hosted Web tool resume requires durable workflow storage.',
    });
    return;
  }

  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  const abortController = new AbortController();
  const removeAbortListeners = listenForAssistantCancellation(req, res, abortController);

  let agentStream: AsyncIterable<StreamChunk>;
  try {
    // The seam admits only explicit request metadata. Hosted Web has no tool
    // registry; permission-policy and server-only runtime fields fail visibly.
    agentStream = await buildWebAssistantStream({
      agentMessages: turn.agentMessages,
      apiKey: provider.apiKey,
      data: turn.payload.data,
      signal: abortController.signal,
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
    sendJsonResponse(
      res,
      WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.status,
      WEB_ASSISTANT_STREAM_INITIALIZATION_FAILURE.payload
    );
    return;
  }

  const response = createStatelessAssistantDataStreamResponse(agentStream);
  try {
    await streamResponse(res, response, abortController.signal);
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
  model?: string;
  provider?: 'openai';
  reason?: string;
} {
  if (provider.enabled && provider.apiKey) {
    return {
      enabled: true,
      model: resolveHostedWebAssistantModel(),
      provider: HOSTED_WEB_ASSISTANT_PROVIDER,
    };
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

function listenForAssistantCancellation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  controller: AbortController
): () => void {
  const abort = (): void => controller.abort();
  const abortIncompleteRequest = (): void => {
    if (!req.complete) {
      abort();
    }
  };
  const abortIncompleteResponse = (): void => {
    if (!res.writableEnded) {
      abort();
    }
  };

  req.on('close', abortIncompleteRequest);
  res.on('close', abortIncompleteResponse);

  if ((req.destroyed && !req.complete) || (res.destroyed && !res.writableEnded)) {
    abort();
  }

  return (): void => {
    req.removeListener('close', abortIncompleteRequest);
    res.removeListener('close', abortIncompleteResponse);
  };
}

function waitForDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const settle = (): void => {
      res.removeListener('drain', settle);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    res.once('drain', settle);
    signal.addEventListener('abort', settle, { once: true });
  });
}

async function writeChunkToResponse(
  value: Uint8Array,
  res: http.ServerResponse,
  signal: AbortSignal
): Promise<void> {
  const writeResult = res.write(value);
  flushResponse(res);
  if (!writeResult) {
    await waitForDrain(res, signal);
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
        await writeChunkToResponse(value, res, signal);
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
  signal: AbortSignal
): Promise<void> {
  writeResponseHeaders(res, response);

  const body = response.body as unknown as ReadableStream<Uint8Array> | null;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();

  try {
    await pipeStreamToResponse(reader, res, signal);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors
    }
    res.end();
  }
}
