const HUGGING_FACE_BASE_URL = 'https://huggingface.co';
// Keep this pinned to the same built-in local model contract as
// packages/agent/src/providers/local/local-model-specs.ts.
const ALLOWED_MODEL_IDS = new Set(['onnx-community/gemma-4-E2B-it-ONNX']);
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

function isAllowedPath(pathSegments: string[]): boolean {
  const modelId = pathSegments.slice(0, 2).join('/');
  return ALLOWED_MODEL_IDS.has(modelId);
}

function buildTargetUrl(request: Request, pathSegments: string[]): string {
  const normalizedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');
  const upstream = new URL(`${HUGGING_FACE_BASE_URL}/${normalizedPath}`);
  const source = new URL(request.url);
  upstream.search = source.search;
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
    headers.set('cache-control', 'public, max-age=300');
  }
  return headers;
}

async function proxyRequest(request: Request, pathSegments: string[]): Promise<Response> {
  if (!isAllowedPath(pathSegments)) {
    return new Response('Unsupported Hugging Face model path.', {
      status: 403,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }
  const targetUrl = buildTargetUrl(request, pathSegments);
  const upstream = await fetch(targetUrl, {
    headers: buildProxyRequestHeaders(request),
    method: 'GET',
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
