export interface FetchJsonResult {
  readonly response: Response;
  readonly payload: unknown | undefined;
  readonly parseError: Error | null;
  readonly latencyMs: number;
}

export interface FetchJsonWithTimeoutOptions {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
  readonly headers?: Record<string, string>;
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
