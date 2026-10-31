import { createHash } from 'node:crypto';
import {
  BoundaryFailureError,
  getLlmModelDefinition,
  type OpenRouterModelMetadata,
  type OpenRouterModelMetadataSnapshot,
  parseOpenRouterModelMetadata,
  refusal,
  refusalError,
} from '@brainstrike/assistant-contract';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { resolveProviderBaseUrl } from './provider-base-url.ts';
import { createSharedFlights } from './shared-flight.ts';

const DEFAULT_SUCCESS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 128;
const MAX_VISIBLE_ERROR_CHARS = 300;
const MAX_MODEL_ID_CHARS = 256;

/**
 * OpenRouter's answer as a refusal the person can act on: a rejected key, an
 * unknown model or an upstream outage is not a host fault, so it crosses with
 * its remedy and is never logged as an error (BST-2374).
 */
function statusRefusal(status: number, modelId: string): BoundaryFailureError {
  if (status === 401) {
    return refusalError(
      'authorization',
      'provider.credential-rejected',
      'OpenRouter rejected the API key (HTTP 401).',
      'Replace the OpenRouter API key in Providers.'
    );
  }
  if (status === 403) {
    return refusalError(
      'authorization',
      'provider.credential-forbidden',
      'OpenRouter refused the API key access to model details (HTTP 403).',
      "Check the key's permissions on OpenRouter, or replace it in Providers."
    );
  }
  if (status === 404) {
    return refusalError(
      'configuration',
      'provider.model-not-found',
      `OpenRouter has no model "${modelId}" (HTTP 404).`,
      'Choose another OpenRouter model.'
    );
  }
  if (status === 429) {
    return refusalError(
      'availability',
      'provider.rate-limited',
      'OpenRouter is rate limiting requests (HTTP 429).',
      'Try again in a moment.'
    );
  }
  return refusalError(
    'availability',
    'provider.upstream-unavailable',
    `OpenRouter Models API returned status ${status}.`,
    'Try again later.'
  );
}

function timeoutRefusal(timeoutMs: number): BoundaryFailureError {
  return refusalError(
    'timeout',
    'provider.timeout',
    `OpenRouter Models API request timed out after ${timeoutMs}ms.`,
    'Check your connection, then try again.'
  );
}

/** The request never reached OpenRouter (offline, DNS, refused); its cause stays local. */
function unreachableRefusal(cause: unknown): BoundaryFailureError {
  return new BoundaryFailureError(
    refusal({
      category: 'availability',
      code: 'provider.unreachable',
      message: 'OpenRouter could not be reached.',
      remedy: 'Check your connection, then try again.',
    }),
    { cause }
  );
}

interface OpenRouterModelMetadataServiceOptions {
  /** Where `OPENROUTER_BASE_URL` is read; the host passes the same env its probes read. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly successTtlMs?: number;
}

export interface OpenRouterModelMetadataService {
  /** `signal` cancels this caller's wait with its reason; the fetch aborts once no caller waits. */
  get(
    modelId: string,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<OpenRouterModelMetadataSnapshot>;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function requireOpenRouterModelId(modelId: string): readonly [string, string] {
  if (modelId.length > MAX_MODEL_ID_CHARS) {
    throw new Error(`OpenRouter model id must be at most ${MAX_MODEL_ID_CHARS} characters`);
  }
  const parts = modelId.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || part.trim() !== part || /\s/u.test(part))
  ) {
    throw new Error('OpenRouter model id must use the provider/model form');
  }
  return [parts[0] as string, parts[1] as string];
}

function buildModelUrl(modelId: string, baseUrl: string): string {
  const [provider, model] = requireOpenRouterModelId(modelId);
  return `${baseUrl}/model/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
}

function toVisibleError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'OpenRouter Models API request failed';
  return message.slice(0, MAX_VISIBLE_ERROR_CHARS);
}

function mergeCatalogBudgetCeilings(metadata: OpenRouterModelMetadata): OpenRouterModelMetadata {
  if (metadata.id !== 'qwen/qwen3.8-flash') {
    return metadata;
  }
  // This fixed OpenRouter route is narrower than the aggregate model listing;
  // its catalogued route limits remain hard ceilings on live metadata.
  const catalogModel = getLlmModelDefinition('openrouter', metadata.id);
  const contextWindow = Math.min(metadata.contextWindow, catalogModel.contextWindow);
  const outputCeilings = [
    metadata.maxOutputTokens,
    catalogModel.maxOutputTokens,
    contextWindow,
  ].filter((value): value is number => value !== undefined);
  const maxOutputTokens = Math.min(...outputCeilings);
  return {
    ...metadata,
    contextWindow,
    maxOutputTokens,
  };
}

export function createOpenRouterModelMetadataService(
  options: OpenRouterModelMetadataServiceOptions = {}
): OpenRouterModelMetadataService {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const successTtlMs = requirePositiveInteger(
    options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS,
    'successTtlMs'
  );
  const requestTimeoutMs = requirePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs'
  );
  const maxCacheEntries = requirePositiveInteger(
    options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
    'maxCacheEntries'
  );
  const cache = new Map<string, OpenRouterModelMetadata>();
  const flights = createSharedFlights<OpenRouterModelMetadataSnapshot>();

  const retain = (cacheKey: string, metadata: OpenRouterModelMetadata): void => {
    cache.delete(cacheKey);
    cache.set(cacheKey, metadata);
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      cache.delete(oldest);
    }
  };

  const refresh = async (
    modelId: string,
    apiKey: string,
    stale: OpenRouterModelMetadata | undefined,
    cacheKey: string,
    modelUrl: string,
    cancelled: AbortSignal
  ): Promise<OpenRouterModelMetadataSnapshot> => {
    try {
      const metadata = await runWithTimeout(
        async (signal: AbortSignal): Promise<OpenRouterModelMetadata> => {
          const response = await fetchImpl(modelUrl, {
            headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
            signal,
          }).catch((error: unknown) => {
            // An aborted fetch answers with the deadline's or the caller's reason.
            signal.throwIfAborted();
            throw unreachableRefusal(error);
          });
          signal.throwIfAborted();
          if (!response.ok) {
            throw statusRefusal(response.status, modelId);
          }
          const body = await response.json();
          signal.throwIfAborted();
          return mergeCatalogBudgetCeilings(parseOpenRouterModelMetadata(body, modelId, now()));
        },
        {
          onTimeout: () => timeoutRefusal(requestTimeoutMs),
          signal: cancelled,
          timeoutMs: requestTimeoutMs,
        }
      );
      retain(cacheKey, metadata);
      return { freshness: 'live', metadata };
    } catch (error) {
      if (!stale) {
        throw error;
      }
      return { freshness: 'stale-cache', metadata: stale, warning: toVisibleError(error) };
    }
  };

  return {
    async get(
      modelId: string,
      apiKey: string,
      signal?: AbortSignal
    ): Promise<OpenRouterModelMetadataSnapshot> {
      requireOpenRouterModelId(modelId);
      const normalizedApiKey = apiKey.trim();
      if (normalizedApiKey.length === 0) {
        throw new Error('OpenRouter API key is required for model metadata');
      }

      const baseUrl = resolveProviderBaseUrl('openrouter', options.env);
      const cacheKey = JSON.stringify([baseUrl, modelId]);
      const cached = cache.get(cacheKey);
      if (cached && now() - cached.checkedAt < successTtlMs) {
        return { freshness: 'fresh-cache', metadata: cached };
      }

      const pendingKey = `${cacheKey}:${createHash('sha256').update(normalizedApiKey).digest('hex')}`;
      const modelUrl = buildModelUrl(modelId, baseUrl);
      return await flights(
        pendingKey,
        (cancelled) => refresh(modelId, normalizedApiKey, cached, cacheKey, modelUrl, cancelled),
        signal
      );
    },
  };
}
