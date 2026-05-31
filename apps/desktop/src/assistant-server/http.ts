import type http from 'node:http';
import { AssistantRequestBodyTooLargeError } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('DesktopAssistantHttpStream');
export const assistantServerHttpStreamLogger = logger;

type ServerResponseWithFlush = http.ServerResponse & {
  flushHeaders?: () => void;
};

export interface ReadRequestBodyOptions {
  maxBodyBytes?: number;
}

export async function readRequestBody(
  req: http.IncomingMessage,
  options: ReadRequestBodyOptions = {}
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    function cleanup() {
      req.removeListener?.('data', onData);
      req.removeListener?.('end', onEnd);
      req.removeListener?.('error', onError);
    }

    function settleReject(error: Error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function onData(chunk: string | Buffer | Uint8Array) {
      if (settled) {
        return;
      }

      const chunkBuffer =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk);
      totalBytes += chunkBuffer.byteLength;
      if (options.maxBodyBytes !== undefined && totalBytes > options.maxBodyBytes) {
        const error = new AssistantRequestBodyTooLargeError(options.maxBodyBytes);
        // Keep the socket alive long enough for the caller to write a JSON 413;
        // the handler marks that response Connection: close before ending it.
        req.pause();
        settleReject(error);
        return;
      }
      chunks.push(chunkBuffer);
    }

    function onEnd() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    }

    function onError(error: Error) {
      settleReject(error);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export async function streamResponse(
  res: http.ServerResponse,
  response: { status: number; headers: Headers; body: ReadableStream | null },
  signal: AbortSignal | null = null
): Promise<void> {
  writeHeaders(res, response.headers);
  try {
    res.setHeader('Connection', 'close');
  } catch {}
  res.writeHead(response.status);

  const body = response.body as unknown as ReadableStream<Uint8Array> | null;
  if (!body) {
    res.end();
    return;
  }
  await pumpReadableToResponse(body, res, signal);
}

export function writeHeaders(res: http.ServerResponse, headers: Headers): void {
  for (const [k, v] of headers.entries()) {
    try {
      res.setHeader(k, v);
    } catch {}
  }
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

async function pumpChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: http.ServerResponse,
  abortState: { aborted: boolean }
): Promise<void> {
  while (!(abortState.aborted || res.destroyed)) {
    const { done, value } = await reader.read();
    if (done || abortState.aborted || res.destroyed) {
      break;
    }
    if (value?.length > 0) {
      await writeChunkToResponse(value, res);
    }
  }
}

export async function pumpReadableToResponse(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  signal?: AbortSignal | null
): Promise<void> {
  const reader = (
    body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }
  ).getReader();
  const abortState = { aborted: Boolean(signal?.aborted) };
  const onAbort = () => {
    abortState.aborted = true;
    try {
      reader.cancel();
    } catch {}
    try {
      res.end();
    } catch {}
  };
  try {
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    await pumpChunks(reader, res, abortState);
  } catch (error) {
    if (!(abortState.aborted || res.destroyed)) {
      logger.error('Stream pipeline failed', { error });
      throw error;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      res.end();
    } catch {}
    if (signal) {
      signal.removeEventListener?.('abort', onAbort as EventListener);
    }
  }
}
