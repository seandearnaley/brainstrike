import type http from 'node:http';

const HUGGING_FACE_BASE_URL = 'https://huggingface.co';
const ALLOWED_MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const ALLOWED_RESOLVE_PREFIX = `/${ALLOWED_MODEL_ID}/resolve/`;

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
  // Must have revision/filename, no traversal
  return afterResolve.includes('/') && !afterResolve.includes('..');
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

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: buildUpstreamHeaders(req),
      method: req.method ?? 'GET',
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
      res.write(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  res.end();
}
