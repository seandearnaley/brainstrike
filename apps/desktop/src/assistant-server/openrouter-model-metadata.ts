import { createHash } from 'node:crypto';
import {
  getLlmModelDefinition,
  type OpenRouterModelMetadata,
  type OpenRouterModelMetadataSnapshot,
  parseOpenRouterModelMetadata,
} from '@brainstrike/assistant-contract';

const DEFAULT_SUCCESS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 128;
const MAX_VISIBLE_ERROR_CHARS = 300;
const MAX_MODEL_ID_CHARS = 256;

interface OpenRouterModelMetadataServiceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly successTtlMs?: number;
}

export interface OpenRouterModelMetadataService {
  get(modelId: string, apiKey: string): Promise<OpenRouterModelMetadataSnapshot>;
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
    parts.some((part) => part.length === 0 || part.trim() !== part || /\s/.test(part))
  ) {
    throw new Error('OpenRouter model id must use the provider/model form');
  }
  return [parts[0] as string, parts[1] as string];
}

function buildModelUrl(modelId: string): string {
  const [provider, model] = requireOpenRouterModelId(modelId);
  return `https://openrouter.ai/api/v1/model/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
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
  const pending = new Map<string, Promise<OpenRouterModelMetadataSnapshot>>();

  const retain = (metadata: OpenRouterModelMetadata): void => {
    cache.delete(metadata.id);
    cache.set(metadata.id, metadata);
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
    stale: OpenRouterModelMetadata | undefined
  ): Promise<OpenRouterModelMetadataSnapshot> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(buildModelUrl(modelId), {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenRouter Models API returned status ${response.status}`);
      }
      const metadata = mergeCatalogBudgetCeilings(
        parseOpenRouterModelMetadata(await response.json(), modelId, now())
      );
      retain(metadata);
      return { freshness: 'live', metadata };
    } catch (error) {
      if (!stale) {
        throw error;
      }
      return { freshness: 'stale-cache', metadata: stale, warning: toVisibleError(error) };
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async get(modelId: string, apiKey: string): Promise<OpenRouterModelMetadataSnapshot> {
      requireOpenRouterModelId(modelId);
      const normalizedApiKey = apiKey.trim();
      if (normalizedApiKey.length === 0) {
        throw new Error('OpenRouter API key is required for model metadata');
      }

      const cached = cache.get(modelId);
      if (cached && now() - cached.checkedAt < successTtlMs) {
        return { freshness: 'fresh-cache', metadata: cached };
      }

      const pendingKey = `${modelId}:${createHash('sha256').update(normalizedApiKey).digest('hex')}`;
      const existing = pending.get(pendingKey);
      if (existing) {
        return existing;
      }
      const request = refresh(modelId, normalizedApiKey, cached).finally(() => {
        pending.delete(pendingKey);
      });
      pending.set(pendingKey, request);
      return request;
    },
  };
}
