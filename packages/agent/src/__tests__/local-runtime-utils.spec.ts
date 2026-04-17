import { describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeAuthHeaders,
  buildRuntimeEndpoint,
  extractErrorMessage,
  fetchJsonWithTimeout,
  isRecord,
  normalizeRuntimeBaseUrl,
  sanitizeDuration,
} from '../providers/local-runtime-utils';

describe('local-runtime-utils', () => {
  it('identifies plain records and rejects arrays/null', () => {
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(['not', 'a', 'record'])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('extracts error messages from Error and non-Error values', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
    expect(extractErrorMessage(404)).toBe('404');
  });

  it('sanitizes duration values with floor and fallback behavior', () => {
    expect(sanitizeDuration(1234.9, 10)).toBe(1234);
    expect(sanitizeDuration(0, 10)).toBe(10);
    expect(sanitizeDuration(Number.NaN, 10)).toBe(10);
  });

  describe('normalizeRuntimeBaseUrl', () => {
    it('accepts host:port shorthand and assumes http://', () => {
      expect(normalizeRuntimeBaseUrl('gpu.lan:11434')).toBe('http://gpu.lan:11434');
    });
    it('strips trailing slashes and a trailing /v1 segment', () => {
      expect(normalizeRuntimeBaseUrl('https://gpu.lan:11434/v1/')).toBe('https://gpu.lan:11434');
      expect(normalizeRuntimeBaseUrl('https://gpu.lan:11434/')).toBe('https://gpu.lan:11434');
    });
    it('preserves non-/v1 pathname segments', () => {
      // `/api/v1` is a real namespace; it must not be collapsed by the /v1 strip.
      expect(normalizeRuntimeBaseUrl('http://host/api/v1')).toBe('http://host/api/v1');
    });
    it('returns null for empty, whitespace, or unparseable values', () => {
      expect(normalizeRuntimeBaseUrl('')).toBeNull();
      expect(normalizeRuntimeBaseUrl('   ')).toBeNull();
      expect(normalizeRuntimeBaseUrl(undefined)).toBeNull();
      expect(normalizeRuntimeBaseUrl(null)).toBeNull();
    });
  });

  describe('buildRuntimeEndpoint', () => {
    it('concatenates a canonical base with an absolute path', () => {
      expect(buildRuntimeEndpoint('http://127.0.0.1:11434', '/api/tags')).toBe(
        'http://127.0.0.1:11434/api/tags'
      );
    });
    it('throws when the path is not absolute', () => {
      expect(() => buildRuntimeEndpoint('http://host', 'relative')).toThrow(/absolute/);
    });
  });

  describe('buildRuntimeAuthHeaders', () => {
    it('returns undefined when no token is configured', () => {
      expect(buildRuntimeAuthHeaders(undefined)).toBeUndefined();
      expect(buildRuntimeAuthHeaders({})).toBeUndefined();
      expect(buildRuntimeAuthHeaders({ apiToken: '   ' })).toBeUndefined();
    });
    it('emits a bearer header for non-empty tokens', () => {
      expect(buildRuntimeAuthHeaders({ apiToken: 'tok_abc' })).toEqual({
        authorization: 'Bearer tok_abc',
      });
    });
  });

  it('adds JSON content-type when sending body and no content-type header is provided', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await fetchJsonWithTimeout('http://localhost:1234/v1/embeddings', {
      fetchImpl,
      timeoutMs: 500,
      method: 'POST',
      body: JSON.stringify({ input: 'hello' }),
    });

    expect(result.parseError).toBeNull();
    const requestInit = fetchImpl.mock.calls[0]?.[1];
    expect(requestInit?.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  it('returns parseError when response json decoding fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await fetchJsonWithTimeout('http://localhost:1234/v1/models', {
      fetchImpl,
      timeoutMs: 500,
    });

    expect(result.parseError).toBeInstanceOf(Error);
    expect(result.payload).toBeUndefined();
  });

  it('propagates upstream pre-aborted signals to the request controller', async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_endpoint, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(
      fetchJsonWithTimeout('http://localhost:1234/v1/models', {
        fetchImpl,
        timeoutMs: 500,
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});
