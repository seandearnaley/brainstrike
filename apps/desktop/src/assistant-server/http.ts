import type http from 'node:http';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('DesktopAssistantHttpStream');
export const assistantServerHttpStreamLogger = logger;

type ServerResponseWithFlush = http.ServerResponse & {
  flushHeaders?: () => void;
};

export async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  await new Promise<void>((resolve) => req.on('end', () => resolve()));
  return body;
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
