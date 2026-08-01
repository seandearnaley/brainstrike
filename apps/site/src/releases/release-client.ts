import { parseReleaseManifest, type ReleaseManifest } from './release-manifest';

const DEFAULT_MANIFEST_PATH = '/release-manifest.json';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const PLACEHOLDER_ORIGIN = 'https://site.invalid';

export type ReleaseManifestFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface ReleaseManifestClientOptions {
  readonly cacheTtlMs?: number;
  readonly fetch?: ReleaseManifestFetch;
  readonly path?: string;
  readonly timeoutMs?: number;
}

export interface ReleaseManifestClient {
  invalidate(): void;
  load(): Promise<ReleaseManifest>;
  retry(): Promise<ReleaseManifest>;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly promise: Promise<ReleaseManifest>;
}

function requireSameOriginPath(path: string): string {
  if (!(path.startsWith('/') && !path.startsWith('//'))) {
    throw new Error('Release manifest path must be an absolute same-origin path.');
  }
  const parsed = new URL(path, PLACEHOLDER_ORIGIN);
  if (
    parsed.origin !== PLACEHOLDER_ORIGIN ||
    parsed.pathname !== path ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error('Release manifest path must be an unambiguous same-origin path.');
  }
  return path;
}

function requireTimeoutMs(timeoutMs: number): number {
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    throw new Error('Release manifest timeoutMs must be a positive safe integer.');
  }
  return timeoutMs;
}

function requireCacheTtlMs(cacheTtlMs: number): number {
  if (!(Number.isSafeInteger(cacheTtlMs) && cacheTtlMs > 0)) {
    throw new Error('Release manifest cacheTtlMs must be a positive safe integer.');
  }
  return cacheTtlMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestFailure(error: unknown, timedOut: boolean, timeoutMs: number): Error {
  if (timedOut) {
    return new Error(`Release manifest request timed out after ${timeoutMs}ms.`, { cause: error });
  }
  return new Error('Release manifest request was invalidated.', { cause: error });
}

async function requestManifest(
  fetchManifest: ReleaseManifestFetch,
  path: string,
  timeoutMs: number,
  controller: AbortController
): Promise<ReleaseManifest> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Release manifest request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
      once: true,
    });
  });

  try {
    let response: Response;
    try {
      response = await Promise.race([
        fetchManifest(path, {
          cache: 'no-cache',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        }),
        aborted,
      ]);
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw requestFailure(error, timedOut, timeoutMs);
      }
      throw new Error(`Release manifest request failed: ${errorMessage(error)}`, { cause: error });
    }

    if (!response.ok) {
      throw new Error(`Release manifest request failed with HTTP ${response.status}.`);
    }

    let value: unknown;
    try {
      value = await Promise.race([response.json() as Promise<unknown>, aborted]);
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw requestFailure(error, timedOut, timeoutMs);
      }
      throw new Error(`Release manifest response was not valid JSON: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    try {
      return parseReleaseManifest(value);
    } catch (error: unknown) {
      throw new Error(`Release manifest validation failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function createReleaseManifestClient(
  options: ReleaseManifestClientOptions = {}
): ReleaseManifestClient {
  const path = requireSameOriginPath(options.path ?? DEFAULT_MANIFEST_PATH);
  const timeoutMs = requireTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const cacheTtlMs = requireCacheTtlMs(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const fetchManifest = options.fetch ?? globalThis.fetch.bind(globalThis);
  let active: ActiveRequest | undefined;
  let cached: ReleaseManifest | undefined;
  let cachedAt: number | undefined;

  const invalidate = (): void => {
    cached = undefined;
    cachedAt = undefined;
    active?.controller.abort(new Error('Release manifest request was invalidated.'));
    active = undefined;
  };

  const load = (): Promise<ReleaseManifest> => {
    if (cached !== undefined && cachedAt !== undefined && Date.now() - cachedAt < cacheTtlMs) {
      return Promise.resolve(cached);
    }
    cached = undefined;
    cachedAt = undefined;
    if (active !== undefined) {
      return active.promise;
    }

    const controller = new AbortController();
    const promise = requestManifest(fetchManifest, path, timeoutMs, controller)
      .then((manifest) => {
        if (controller.signal.aborted) {
          throw new Error('Release manifest request was invalidated.');
        }
        cached = manifest;
        cachedAt = Date.now();
        return manifest;
      })
      .finally(() => {
        if (active?.promise === promise) {
          active = undefined;
        }
      });
    active = { controller, promise };
    return promise;
  };

  const retry = (): Promise<ReleaseManifest> => {
    invalidate();
    return load();
  };

  return { invalidate, load, retry };
}
