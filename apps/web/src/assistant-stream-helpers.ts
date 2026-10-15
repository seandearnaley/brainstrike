import type http from 'node:http';
import {
  AssistantRequestBodyTooLargeError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  type StreamChunk,
} from '@brainstrike/agent';
import { createStatelessAssistantDataStreamResponse } from '@brainstrike/agent/hosted-web';
import { createLogger } from '@brainstrike/logging';
import {
  resolveAssistantProviderConfig,
  resolveHostedWebAssistantStatus,
} from './server/assistant-config';
import { runWebAssistantPost, type WebAssistantPostOutcome } from './server/web-assistant-post';
import { WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE } from './server/web-assistant-request';

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

/**
 * Node transport shell over the converged decision core in
 * `server/web-assistant-post.ts` (BST-973-2). This function owns only what
 * touches the raw req/res: the `last-event-id` -> 409 replay rejection and
 * the cancellation/back-pressure pump. Everything else — 503 gate, allow-list
 * pre-filter, the SHARED prepareAssistantPostRequest, tool-continuation 409s,
 * stream construction — is the core, shared byte-for-byte with the deployed
 * Vercel route so dev and prod cannot drift apart.
 */
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

  const abortController = new AbortController();
  const removeAbortListeners = listenForAssistantCancellation(req, res, abortController);

  let outcome: WebAssistantPostOutcome;
  try {
    outcome = await runWebAssistantPost({ bodyText, logger, signal: abortController.signal });
  } catch (error) {
    removeAbortListeners();
    throw error;
  }
  if (outcome.kind === 'rejection') {
    removeAbortListeners();
    sendJsonResponse(res, outcome.status, { ...outcome.payload });
    return;
  }

  const response = createStatelessAssistantDataStreamResponse(outcome.stream);
  try {
    await streamResponse(res, response, abortController.signal);
  } finally {
    removeAbortListeners();
  }
}

export function sendAssistantStatusResponse(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(resolveHostedWebAssistantStatus(resolveAssistantProviderConfig)));
}

function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>
): void {
  res.writeHead(status, JSON_RESPONSE_HEADERS);
  res.end(JSON.stringify(payload));
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
