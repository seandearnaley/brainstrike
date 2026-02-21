import { describe, expect, it, vi } from 'vitest';
import {
  extractErrorMessage,
  fetchJsonWithTimeout,
  isRecord,
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
