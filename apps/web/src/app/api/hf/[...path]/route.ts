import { createLogger } from '@brainstrike/utils/logger';

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
const PASSTHROUGH_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;
const logger = createLogger('HuggingFaceProxyRoute');

export const runtime = 'nodejs';

function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\')
  );
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

function buildTargetUrl(_request: Request, pathSegments: string[]): string {
  const normalizedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');
  const upstream = new URL(`${HUGGING_FACE_BASE_URL}/${normalizedPath}`);
  upstream.search = '';

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
  if (!upstream.ok && upstream.status !== 304) {
    headers.set('cache-control', 'no-store');
    return headers;
  }
  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
  }
  return headers;
}

function isTrustedSameOriginRequest(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const requestOrigin = requestUrl.origin;
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite) {
    return secFetchSite === 'same-origin';
  }

  const originHeader = request.headers.get('origin');
  if (originHeader) {
    try {
      return new URL(originHeader).origin === requestOrigin;
    } catch {
      return false;
    }
  }

  const referrerSource =
    request.referrer.length > 0 && request.referrer !== 'about:client'
      ? request.referrer
      : request.headers.get('referer');
  if (referrerSource) {
    try {
      return new URL(referrerSource).origin === requestOrigin;
    } catch {
      return false;
    }
  }

  return false;
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

function createForbiddenProxyResponse(): Response {
  return new Response('Forbidden Hugging Face proxy request.', {
    status: 403,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-brainstrike-proxy-rejection': 'origin',
    },
  });
}

async function proxyRequest(request: Request, pathSegments: string[]): Promise<Response> {
  if (!isTrustedSameOriginRequest(request)) {
    logger.warn('Rejected Hugging Face proxy request due to origin trust check', {
      hasOrigin: request.headers.has('origin'),
      hasReferer: request.headers.has('referer'),
      method: request.method,
      path: pathSegments.join('/'),
      secFetchSite: request.headers.get('sec-fetch-site'),
    });
    return createForbiddenProxyResponse();
  }
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
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: buildProxyRequestHeaders(request),
      // Next.js only exports GET/HEAD for this route, so request.method is already constrained here.
      method: request.method,
      signal: request.signal,
    });
  } catch (error) {
    logger.error('Hugging Face proxy request failed', {
      error: error instanceof Error ? error.message : String(error),
      path: pathSegments.join('/'),
    });
    return new Response('Failed to reach Hugging Face upstream.', {
      status: 502,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  return new Response(upstream.body, {
    headers: buildProxyResponseHeaders(upstream),
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

async function proxyHeadRequest(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await context.params;
  const response = await proxyRequest(request, path);
  return new Response(null, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await context.params;
  return await proxyRequest(request, path);
}

export const HEAD = proxyHeadRequest;
