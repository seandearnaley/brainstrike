import {
  type ClientOptions,
  InMemoryResponseCacheStore,
  type ResponseCacheStore,
} from '@modelcontextprotocol/client';

export const DEFAULT_MCP_LIST_MAX_PAGES = 64;
export const MAX_MCP_LIST_MAX_PAGES = 256;
export const MCP_RESPONSE_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS = 600_000;
// The default keeps ordinary requests bounded, while the one-hour ceiling lets
// explicitly approved long-running tools outlive that default without creating
// an unbounded progress-reset loop.
export const MAX_MCP_MAX_TOTAL_TIMEOUT_MS = 3_600_000;

export function normalizeMcpCachePartition(
  value: unknown,
  sharedStore: boolean
): string | undefined {
  if (value === undefined) {
    if (sharedStore) {
      throw new Error(
        'MCP response cache partition is required when sharing a response cache store'
      );
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('MCP response cache partition must be a string');
  }
  if (value.trim().length === 0) {
    throw new Error('MCP response cache partition must not be empty');
  }
  return value.trim();
}

export function normalizeMcpListMaxPages(value: unknown): number {
  const listMaxPages: unknown = value ?? DEFAULT_MCP_LIST_MAX_PAGES;
  if (
    typeof listMaxPages !== 'number' ||
    !Number.isSafeInteger(listMaxPages) ||
    listMaxPages < 1 ||
    listMaxPages > MAX_MCP_LIST_MAX_PAGES
  ) {
    throw new Error(
      `MCP automatic list pagination cap must be a positive safe integer at most ${MAX_MCP_LIST_MAX_PAGES}`
    );
  }
  return listMaxPages;
}

export function createMcpResponseCacheStore(
  store: ClientOptions['responseCacheStore']
): ResponseCacheStore {
  return store ?? new InMemoryResponseCacheStore({ maxEntries: MCP_RESPONSE_CACHE_MAX_ENTRIES });
}

export function normalizeMcpRequestOptions<T extends { maxTotalTimeout?: number }>(
  options: T | undefined
): T & { maxTotalTimeout: number } {
  const maxTotalTimeout = options?.maxTotalTimeout ?? DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(maxTotalTimeout) ||
    maxTotalTimeout < 1 ||
    maxTotalTimeout > MAX_MCP_MAX_TOTAL_TIMEOUT_MS
  ) {
    throw new Error(
      `MCP absolute timeout must be a positive safe integer at most ${MAX_MCP_MAX_TOTAL_TIMEOUT_MS}`
    );
  }
  return { ...options, maxTotalTimeout } as T & { maxTotalTimeout: number };
}
