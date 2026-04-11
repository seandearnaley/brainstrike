const HUGGING_FACE_BASE_URL = 'https://huggingface.co';

function buildTargetUrl(pathSegments: string[]): string {
  const normalizedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');
  return `${HUGGING_FACE_BASE_URL}/${normalizedPath}`;
}

async function proxyRequest(request: Request, pathSegments: string[]): Promise<Response> {
  const targetUrl = buildTargetUrl(pathSegments);
  const upstream = await fetch(targetUrl, {
    headers: {
      accept: request.headers.get('accept') ?? '*/*',
      'user-agent': 'brainstrike-local-llm',
    },
    method: request.method,
  });

  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  const contentLength = upstream.headers.get('content-length');
  const cacheControl = upstream.headers.get('cache-control');

  if (contentType) {
    headers.set('content-type', contentType);
  }
  if (contentLength) {
    headers.set('content-length', contentLength);
  }
  if (cacheControl) {
    headers.set('cache-control', cacheControl);
  }

  return new Response(upstream.body, {
    headers,
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
