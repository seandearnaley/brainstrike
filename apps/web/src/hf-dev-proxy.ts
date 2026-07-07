import type http from 'node:http';

const HUGGING_FACE_BASE_URL = 'https://huggingface.co';
const ALLOWED_MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const ALLOWED_RESOLVE_PREFIX = `/${ALLOWED_MODEL_ID}/resolve/`;
// INACTIVITY window, never a wall-clock ceiling: model shards are multi-GB
// and take minutes to stream — a whole-transfer deadline truncates them
// mid-stream (browser: ERR_CONTENT_LENGTH_MISMATCH; transformers.js: an
// unhandled "network error"). The deadline refreshes on every chunk, so a
// healthy slow download survives while a wedged upstream still aborts.
const UPSTREAM_INACTIVITY_TIMEOUT_MS = 30_000;

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'if-modified-since',
  'if-none-match',
  'range',
] as const;

const PASSTHROUGH_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;

export function isAllowedHfDevPath(path: string): boolean {
  if (!path.startsWith(ALLOWED_RESOLVE_PREFIX)) {
    return false;
  }
  const afterResolve = path.slice(ALLOWED_RESOLVE_PREFIX.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(afterResolve);
  } catch {
    return false;
  }
  return decoded.includes('/') && !decoded.includes('..');
}

export function buildHfTargetUrl(path: string): string {
  return `${HUGGING_FACE_BASE_URL}${path}`;
}

function buildUpstreamHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  headers.set('user-agent', 'brainstrike-local-llm');
  if (!headers.has('accept')) {
    headers.set('accept', '*/*');
  }
  return headers;
}

function buildResponseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  if (!upstream.ok && upstream.status !== 304) {
    headers['cache-control'] = 'no-store';
    return headers;
  }
  if (!headers['cache-control']) {
    headers['cache-control'] = 'public, max-age=31536000, immutable';
  }
  return headers;
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestOrigin(req: http.IncomingMessage): string | null {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.trim().length === 0) {
    return null;
  }
  const protoHeader = req.headers['x-forwarded-proto'];
  const protocol =
    typeof protoHeader === 'string' ? protoHeader.split(',')[0]?.trim() || 'http' : 'http';
  return parseOrigin(`${protocol}://${host}`);
}

function isTrustedSameOriginDevRequest(req: http.IncomingMessage): boolean {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string') {
    return secFetchSite === 'same-origin';
  }

  const expectedOrigin = requestOrigin(req);
  for (const header of [req.headers.origin, req.headers.referer]) {
    if (typeof header === 'string') {
      return expectedOrigin !== null && parseOrigin(header) === expectedOrigin;
    }
  }

  return false;
}

interface InactivityAbort {
  dispose: () => void;
  signal: AbortSignal;
  /** Refresh the inactivity deadline — call on every received chunk. */
  touch: () => void;
}

function createInactivityAbort(req: http.IncomingMessage, windowMs: number): InactivityAbort {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timer = setTimeout(abort, windowMs);
  req.on('close', abort);
  req.on('aborted', abort);
  return {
    dispose: () => {
      clearTimeout(timer);
      req.off('close', abort);
      req.off('aborted', abort);
    },
    signal: controller.signal,
    touch: () => {
      clearTimeout(timer);
      timer = setTimeout(abort, windowMs);
    },
  };
}

/**
 * Race a body read against the abort signal: real fetch errors the body
 * stream on abort, but the read must terminate even if the underlying
 * stream never reacts (a wedged upstream is exactly the timeout case).
 */
function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function waitForDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = () => {
      res.off('drain', settle);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    res.once('drain', settle);
    signal.addEventListener('abort', settle, { once: true });
  });
}

async function streamUpstreamBody(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  inactivity: Pick<InactivityAbort, 'signal' | 'touch'>
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, inactivity.signal);
      if (done) {
        break;
      }
      inactivity.touch();
      const ok = res.write(value);
      if (!ok) {
        await waitForDrain(res, inactivity.signal);
      }
    }
  } catch (error) {
    // Headers are already sent: a clean end() would silently truncate the
    // payload against its declared content-length. Kill the socket so the
    // browser sees an unambiguous network failure, and rethrow so the dev
    // middleware logs it — never a silent fallback.
    res.destroy();
    throw error;
  } finally {
    reader.cancel().catch(() => {});
  }
  res.end();
}

export interface HfDevProxyOptions {
  inactivityTimeoutMs?: number;
}

export async function handleHfProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options?: HfDevProxyOptions
): Promise<void> {
  const requestUrl = req.url ?? '';
  const hfPath = requestUrl.replace(/^\/api\/hf/, '');

  if (!isTrustedSameOriginDevRequest(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden Hugging Face proxy request.');
    return;
  }

  if (!isAllowedHfDevPath(hfPath)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Unsupported Hugging Face model path.');
    return;
  }

  const targetUrl = buildHfTargetUrl(hfPath);
  const inactivity = createInactivityAbort(
    req,
    options?.inactivityTimeoutMs ?? UPSTREAM_INACTIVITY_TIMEOUT_MS
  );

  try {
    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        headers: buildUpstreamHeaders(req),
        method: req.method ?? 'GET',
        signal: inactivity.signal,
      });
    } catch {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Failed to reach Hugging Face upstream.');
      return;
    }
    inactivity.touch();

    const responseHeaders = buildResponseHeaders(upstream);
    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    await streamUpstreamBody(upstream.body as ReadableStream<Uint8Array>, res, inactivity);
  } finally {
    inactivity.dispose();
  }
}
