import type http from 'node:http';

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
  signal?: AbortSignal | null
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

export async function pumpReadableToResponse(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  signal?: AbortSignal | null
): Promise<void> {
  const reader = (
    body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }
  ).getReader();
  let aborted = Boolean(signal?.aborted);
  const onAbort = () => {
    aborted = true;
    try {
      res.end();
    } catch {}
  };
  try {
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted) break;
      if (value && value.length > 0) res.write(value);
    }
  } catch {
  } finally {
    try {
      res.end();
    } catch {}
    if (signal) signal.removeEventListener?.('abort', onAbort as EventListener);
  }
}
