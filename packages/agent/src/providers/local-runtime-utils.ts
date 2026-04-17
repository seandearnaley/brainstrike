export interface LocalRuntimeEndpointConfig {
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on every request.
   * Used for Ollama Turbo/Cloud or LM Studio 0.4.0+ token-authenticated servers.
   */
  readonly apiToken?: string;
  /**
   * Canonical origin without trailing slash or `/v1` suffix, e.g.
   * `http://127.0.0.1:11434` or `https://my-gpu-box.lan:11434`. Empty or
   * invalid values are treated as "use default".
   */
  readonly baseUrl?: string;
}

export interface FetchJsonResult {
  readonly latencyMs: number;
  readonly parseError: Error | null;
  readonly payload: unknown | undefined;
  readonly response: Response;
}

export interface FetchJsonWithTimeoutOptions {
  readonly body?: string;
  readonly fetchImpl: typeof fetch;
  readonly headers?: Record<string, string>;
  readonly method?: 'GET' | 'POST';
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function sanitizeDuration(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Normalize a user-supplied base URL into a canonical origin we can build paths
 * off of. Accepts input with or without a scheme, trims whitespace, strips a
 * trailing slash and a trailing `/v1` so callers can always append `/v1/models`
 * or `/api/tags` without double-segments.
 *
 * Returns `null` when the input is empty or cannot be parsed into a URL.
 */
export function normalizeRuntimeBaseUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  let pathname = parsed.pathname;
  while (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  // Strip a trailing `/v1` so we always have a clean origin to join against.
  // `/api/v1` is left alone — that is a real namespace segment.
  if (pathname.toLowerCase() === '/v1') {
    pathname = '';
  }

  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

/**
 * Join a normalized base URL with a runtime-relative path. `path` must begin
 * with a forward slash; the base must already be canonicalized by
 * `normalizeRuntimeBaseUrl`.
 */
export function buildRuntimeEndpoint(baseUrl: string, path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`path must be absolute, received: ${path}`);
  }
  return `${baseUrl}${path}`;
}

/**
 * Compose request headers for a runtime endpoint, adding the bearer token when
 * one is configured. Returns `undefined` when nothing needs to be added so the
 * caller can omit the `headers` field entirely.
 */
export function buildRuntimeAuthHeaders(
  config: LocalRuntimeEndpointConfig | undefined
): Record<string, string> | undefined {
  const token = config?.apiToken?.trim();
  if (!token) {
    return;
  }
  return { authorization: `Bearer ${token}` };
}

export async function fetchJsonWithTimeout(
  endpoint: string,
  options: FetchJsonWithTimeoutOptions
): Promise<FetchJsonResult> {
  const controller = new AbortController();
  const timeoutHandle = globalThis.setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'AbortError'));
  }, options.timeoutMs);

  const upstreamAbortHandler = () => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', upstreamAbortHandler);
  if (options.signal?.aborted) {
    controller.abort();
  }

  const startedAt = Date.now();
  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(options.headers ?? {}),
    };
    if (
      options.body &&
      !Object.keys(headers).some((headerName) => headerName.toLowerCase() === 'content-type')
    ) {
      headers['content-type'] = 'application/json';
    }

    const response = await options.fetchImpl(endpoint, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body ? { body: options.body } : {}),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { response, payload: undefined, parseError: null, latencyMs };
    }

    try {
      const payload = await response.json();
      return { response, payload, parseError: null, latencyMs };
    } catch (error) {
      return {
        response,
        payload: undefined,
        parseError: error instanceof Error ? error : new Error(String(error)),
        latencyMs,
      };
    }
  } finally {
    globalThis.clearTimeout(timeoutHandle);
    options.signal?.removeEventListener('abort', upstreamAbortHandler);
  }
}
