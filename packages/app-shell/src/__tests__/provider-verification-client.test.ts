// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { fetchProviderVerification } from '../provider-verification-client';

const snapshot = {
  freshness: 'live',
  result: {
    checkedAt: '2026-08-18T12:00:00.000Z',
    detail: 'usage 0 (no limit)',
    status: 'verified',
  },
};

describe('fetchProviderVerification', () => {
  it('requests the verify-provider endpoint and returns the parsed snapshot', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 }));

    await expect(
      fetchProviderVerification({
        authHeaders: { 'x-test-auth': 'token' },
        baseUrl: 'http://127.0.0.1:51234',
        fetchImpl,
        providerId: 'openrouter',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual(snapshot);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:51234/assistant/verify-provider?provider=openrouter',
      expect.objectContaining({ headers: { 'x-test-auth': 'token' } })
    );
  });

  it('surfaces the server error message on a non-OK response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'unknown_provider',
          message: 'Provider id is not a verifiable provider.',
        }),
        { status: 400 }
      )
    );

    await expect(
      fetchProviderVerification({
        authHeaders: {},
        baseUrl: 'http://127.0.0.1:51234',
        fetchImpl,
        providerId: 'nope',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('Provider id is not a verifiable provider.');
  });

  it('rejects a malformed snapshot instead of returning it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ freshness: 'live', result: { status: 'maybe' } }), {
        status: 200,
      })
    );

    await expect(
      fetchProviderVerification({
        authHeaders: {},
        baseUrl: 'http://127.0.0.1:51234',
        fetchImpl,
        providerId: 'openai',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('status');
  });
});
