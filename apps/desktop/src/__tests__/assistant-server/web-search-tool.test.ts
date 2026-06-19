/**
 * Unit coverage for the desktop `brainstrike.webSearch` tool (runWebSearch).
 *
 * All cases are HERMETIC: the Tavily fetch and the key resolver are injected,
 * so no real network call is ever made and the encrypted keychain is never
 * touched. Proves the NO-SILENT-FALLBACKS contract (no key → non-fatal
 * "unavailable"; error/timeout → non-fatal error result, logged), that the key
 * is read server-side and never leaked into the result, and that many results
 * are token-budgeted with truncated + hint.
 */
import type { WebSearchInput } from '@brainstrike/agent';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runWebSearch,
  type WebSearchToolDependencies,
} from '../../assistant-server/web-search-tool';

const SECRET_TAVILY_KEY = 'tvly-SECRET-should-never-leak';

function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function tavilyBody(
  results: Array<{ title: string; url: string; content: string }>
): Record<string, unknown> {
  return { results };
}

describe('runWebSearch (desktop webSearch tool)', () => {
  const baseInput: WebSearchInput = { query: 'how to use AbortController' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a NON-FATAL unavailable result when no Tavily key is configured (no network)', async () => {
    const fetchImpl = vi.fn();
    const deps: WebSearchToolDependencies = {
      resolveApiKey: () => Promise.resolve(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    const result = await runWebSearch(baseInput, deps);

    expect(result.available).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.message).toContain('Tavily API key');
    // No throw, and crucially: the network was never touched.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves the key server-side, sends it as a Bearer header, and never leaks it into the result', async () => {
    const fetchImpl = vi.fn((_, init?: RequestInit) => {
      // The key reaches Tavily via the auth header (server-side only).
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.authorization).toBe(`Bearer ${SECRET_TAVILY_KEY}`);
      return Promise.resolve(
        okJsonResponse(
          tavilyBody([{ title: 'MDN', url: 'https://mdn.example/ac', content: 'AbortController' }])
        )
      );
    });
    const resolveApiKey = vi.fn(() => Promise.resolve(SECRET_TAVILY_KEY));
    const deps: WebSearchToolDependencies = {
      resolveApiKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    const result = await runWebSearch(baseInput, deps);

    // Key was resolved server-side (env/keychain path).
    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe('https://mdn.example/ac');
    // The key must NOT appear anywhere in the serialized result handed to the model.
    expect(JSON.stringify(result)).not.toContain(SECRET_TAVILY_KEY);
  });

  it('returns a NON-FATAL error result (logged) when Tavily responds non-OK; run continues', async () => {
    const records: LogRecord[] = [];
    const removeListener = addLogListener((record) => records.push(record), LogLevel.ERROR);
    try {
      const fetchImpl = vi.fn(() =>
        Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) } as Response)
      );
      const deps: WebSearchToolDependencies = {
        resolveApiKey: () => Promise.resolve(SECRET_TAVILY_KEY),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      };

      const result = await runWebSearch(baseInput, deps);

      // Non-fatal: a result, not a throw. Marked available (key exists) with an error.
      expect(result.available).toBe(true);
      expect(result.error).toContain('401');
      expect(result.results).toEqual([]);
      // It was logged, and the log must not contain the key.
      expect(records.some((r) => r.message.includes('webSearch'))).toBe(true);
      expect(JSON.stringify(records)).not.toContain(SECRET_TAVILY_KEY);
    } finally {
      removeListener();
    }
  });

  it('returns a NON-FATAL timeout result when the fetch aborts (no hang, run continues)', async () => {
    // Simulate the AbortController firing: reject with an AbortError, mirroring
    // what fetch throws when the signal aborts.
    const fetchImpl = vi.fn(
      (_: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        })
    );
    const deps: WebSearchToolDependencies = {
      resolveApiKey: () => Promise.resolve(SECRET_TAVILY_KEY),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    };

    const result = await runWebSearch(baseInput, deps);

    expect(result.available).toBe(true);
    expect(result.error).toContain('timed out');
    expect(result.results).toEqual([]);
  });

  it('token-budgets many results: returns truncated + hint, bounded', async () => {
    // Build many large results so the serialized output exceeds the budget and
    // must be trimmed. Titles are uncapped (snippets are bounded per-item), so a
    // long title is the reliable way to overflow the ~11000-char budget with the
    // 10-result maxResults cap.
    const many = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i} ${'T'.repeat(2000)}`,
      url: `https://example.com/result-${i}`,
      content: 'C'.repeat(5000),
    }));
    const fetchImpl = vi.fn(() => Promise.resolve(okJsonResponse(tavilyBody(many))));
    const deps: WebSearchToolDependencies = {
      resolveApiKey: () => Promise.resolve(SECRET_TAVILY_KEY),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    const result = await runWebSearch({ query: 'big', maxResults: 10 }, deps);

    expect(result.available).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.hint).toBeTruthy();
    // Fewer results were returned than the total Tavily provided.
    expect(result.results.length).toBeLessThan(result.totalResults);
    // Each snippet was bounded (the … marker proves the per-item cap fired).
    for (const item of result.results) {
      expect(item.snippet.length).toBeLessThanOrEqual(601);
    }
    // The whole serialized payload stays well under the transport guard budget.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2750 * 4);
  });
});
