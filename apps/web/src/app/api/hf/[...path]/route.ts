const HUGGING_FACE_BASE_URL = 'https://huggingface.co';
// Keep this pinned to the same built-in local model contract as
// packages/agent/src/providers/local/local-model-specs.ts.
const ALLOWED_MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const ALLOWED_MODEL_REVISION = '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9';
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'if-modified-since',
  'if-none-match',
  'range',
] as const;
const UPSTREAM_TIMEOUT_MS = 60_000;
const PASSTHROUGH_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;

function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..';
}

function isAllowedPath(pathSegments: string[]): boolean {
  if (pathSegments.length < 5 || !pathSegments.every(isSafePathSegment)) {
    return false;
  }

  return (
    pathSegments[0] === 'onnx-community' &&
    pathSegments[1] === 'gemma-4-E2B-it-ONNX' &&
    pathSegments[2] === 'resolve' &&
    pathSegments[3] === ALLOWED_MODEL_REVISION
  );
}

function buildTargetUrl(request: Request, pathSegments: string[]): string {
  const normalizedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');
  const upstream = new URL(`${HUGGING_FACE_BASE_URL}/${normalizedPath}`);
  const source = new URL(request.url);
  upstream.search = source.search;

  if (!upstream.pathname.startsWith(`/${ALLOWED_MODEL_ID}/resolve/${ALLOWED_MODEL_REVISION}/`)) {
    throw new Error('unsupported_hf_path');
  }

  return upstream.toString();
}

function buildProxyRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const headerName of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  headers.set('user-agent', 'brainstrike-local-llm');
  if (!headers.has('accept')) {
    headers.set('accept', '*/*');
  }
  return headers;
}

function buildProxyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const headerName of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  if (!headers.has('cache-control')) {
    headers.set('cache-control', upstream.ok ? 'public, max-age=300' : 'no-store');
  }
  return headers;
}

function createUnsupportedPathResponse(): Response {
  return new Response('Unsupported Hugging Face model path.', {
    status: 403,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

async function proxyRequest(request: Request, pathSegments: string[]): Promise<Response> {
  if (!isAllowedPath(pathSegments)) {
    return createUnsupportedPathResponse();
  }
  let targetUrl: string;
  try {
    targetUrl = buildTargetUrl(request, pathSegments);
  } catch (error) {
    if (error instanceof Error && error.message === 'unsupported_hf_path') {
      return createUnsupportedPathResponse();
    }
    throw error;
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
  const upstream = await fetch(targetUrl, {
    headers: buildProxyRequestHeaders(request),
    method: request.method,
    signal,
  });

  return new Response(upstream.body, {
    headers: buildProxyResponseHeaders(upstream),
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await context.params;
  return await proxyRequest(request, path);
}

export const HEAD = GET;
