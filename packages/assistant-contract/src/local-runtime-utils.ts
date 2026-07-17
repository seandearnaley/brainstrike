/**
 * Minimal structural interface for a logger. Matches the shape produced by
 * `@brainstrike/utils/logger` without importing it, so tests can pass plain
 * mocks and the discovery/catalog services stay decoupled from the logging
 * implementation.
 */
export interface LocalRuntimeLogger {
  readonly debug: (message: string, meta?: unknown) => void;
  readonly error: (message: string, meta?: unknown) => void;
  readonly info: (message: string, meta?: unknown) => void;
  readonly warn: (message: string, meta?: unknown) => void;
}

/**
 * Shared no-op logger used as the default when a service is instantiated
 * without a logger. Kept here so the same instance (and the same absence
 * of behaviour) is used by every service — avoids the previous pattern
 * of each service declaring its own private `noopLogger` constant.
 */
export const noopLocalRuntimeLogger: LocalRuntimeLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

export interface LocalRuntimeEndpointConfig {
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on every request.
   * Used for Ollama Turbo/Cloud or LM Studio 0.4.0+ token-authenticated servers.
   */
  readonly apiToken?: string;
  /**
   * Origin for the local runtime, e.g. `http://127.0.0.1:11434` or
   * `https://my-gpu-box.lan:11434`. Callers MAY pass unnormalized values
   * (trailing slash, `/v1` suffix, scheme omitted, etc.) — all entry points
   * that consume this field run it through `normalizeRuntimeBaseUrl` before
   * composing request URLs, so a buggy hand-constructed shape is repaired
   * at the boundary rather than leaking a malformed URL into fetch calls.
   * Empty or invalid values are treated as "use default".
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
 * Returns `null` when the input is empty, unparseable, or carries a scheme
 * the services cannot use (e.g. `ftp://`, `ws://`, `file:///`). Silently
 * accepting those would fail later at fetch time with an opaque network
 * error; rejecting here surfaces a recognisable "unsupported URL" from the
 * Settings baseUrl input.
 */
export function normalizeRuntimeBaseUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Detect a URI scheme prefix without confusing it for `host:port`
  // shorthand. Two signals distinguish "scheme" from "port":
  //   - `scheme://...` (e.g. `ftp://host` — the `//` is always present in
  //     hierarchical schemes we care about).
  //   - `scheme:opaque` with a non-digit, non-slash immediately after the
  //     colon (e.g. `javascript:alert(1)`, `data:...`). `host:11434`
  //     always has a digit after the colon, so it avoids this branch.
  const hierarchicalSchemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  const opaqueSchemeMatch = /^([a-z][a-z0-9+.-]*):(?![\d/])/i.exec(trimmed);
  const schemeMatch = hierarchicalSchemeMatch ?? opaqueSchemeMatch;
  if (schemeMatch) {
    const lowered = (schemeMatch[1] ?? '').toLowerCase();
    if (lowered !== 'http' && lowered !== 'https') {
      return null;
    }
  }
  const withScheme = hierarchicalSchemeMatch ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  // Double-check after parsing — URL normalization can surprise.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  // Userinfo (`parsed.username` / `parsed.password`) is intentionally
  // discarded by the `${protocol}//${host}${pathname}` reconstruction
  // below — `URL#host` excludes it. Embedded credentials in a local-runtime
  // URL are almost never what the user wants: bearer auth flows via the
  // separate `apiToken` field, not via `user:pass@host`. A user pasting
  // `http://secret@host/` gets back the canonical origin without `secret`;
  // if they were relying on HTTP basic auth this is a visible change.
  // Documented here so the silent drop is intentional, not an oversight.

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
 * Validate a bearer token can be safely placed in an HTTP `Authorization`
 * header value. Rejects characters that either let the token forge additional
 * headers (CR/LF — RFC 7230 §3.2.4 header injection) or that no compliant
 * HTTP client will transmit anyway (NUL).
 *
 * Returns the trimmed token on success and throws on rejection so the caller
 * surfaces a recognisable error rather than letting the malformed value flow
 * into a network library that may truncate, throw opaque errors, or inject
 * the trailing payload into a separate header.
 *
 * Centralised here so every consumer — header construction in
 * `buildRuntimeAuthHeaders`, the OpenAI-compat `apiKey` plumbing in
 * `provider-factory.ts`, and any future bearer-auth path — runs the same
 * check.
 */
export function assertSafeBearerToken(token: string): string {
  const trimmed = token.trim();
  if (/[\r\n\0]/.test(trimmed)) {
    throw new Error(
      'API token contains invalid characters (CR/LF/NUL); remove control characters before saving'
    );
  }
  return trimmed;
}

/**
 * Build request headers for a runtime endpoint, adding the bearer token when
 * one is configured. Returns `undefined` when nothing needs to be added so the
 * caller can omit the `headers` field entirely.
 */
export function buildRuntimeAuthHeaders(
  config: LocalRuntimeEndpointConfig | undefined
): Record<string, string> | undefined {
  const raw = config?.apiToken?.trim();
  if (!raw) {
    return;
  }
  const safe = assertSafeBearerToken(raw);
  return { authorization: `Bearer ${safe}` };
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
      headers,
      method: options.method ?? 'GET',
      ...(options.body ? { body: options.body } : {}),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { latencyMs, parseError: null, payload: undefined, response };
    }

    try {
      const payload = await response.json();
      return { latencyMs, parseError: null, payload, response };
    } catch (error) {
      return {
        latencyMs,
        parseError: error instanceof Error ? error : new Error(String(error)),
        payload: undefined,
        response,
      };
    }
  } finally {
    globalThis.clearTimeout(timeoutHandle);
    options.signal?.removeEventListener('abort', upstreamAbortHandler);
  }
}
