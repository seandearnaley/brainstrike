import type http from 'node:http';

const HUGGING_FACE_BASE_URL = 'https://huggingface.co';
const ALLOWED_MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const ALLOWED_RESOLVE_PREFIX = `/${ALLOWED_MODEL_ID}/resolve/`;
const UPSTREAM_TIMEOUT_MS = 30_000;

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
  if (!headers['cache-control']) {
    headers['cache-control'] = upstream.ok ? 'public, max-age=31536000, immutable' : 'no-store';
  }
  return headers;
}

function createAbortSignal(req: http.IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on('close', onClose);
  req.on('aborted', onClose);
  AbortSignal.timeout(UPSTREAM_TIMEOUT_MS).addEventListener('abort', onClose);
  return controller.signal;
}

export async function handleHfProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const requestUrl = req.url ?? '';
  const hfPath = requestUrl.replace(/^\/api\/hf/, '');

  if (!isAllowedHfDevPath(hfPath)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Unsupported Hugging Face model path.');
    return;
  }

  const targetUrl = buildHfTargetUrl(hfPath);
  const signal = createAbortSignal(req);

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: buildUpstreamHeaders(req),
      method: req.method ?? 'GET',
      signal,
    });
  } catch {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Failed to reach Hugging Face upstream.');
    return;
  }

  const responseHeaders = buildResponseHeaders(upstream);
  res.writeHead(upstream.status, responseHeaders);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const ok = res.write(value);
      if (!ok) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  res.end();
}
