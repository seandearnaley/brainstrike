import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderVerification } from '../provider-verification-client';
import { useProviderVerification } from './use-provider-verification';

vi.mock('../provider-verification-client', () => ({
  fetchProviderVerification: vi.fn(),
}));

vi.mock('./use-assistant-availability', () => ({
  resolveAssistantAuthHeaders: async () => ({ 'x-test-auth': 'token' }),
  resolveAssistantBaseUrl: async () => 'http://127.0.0.1:51234',
}));

const snapshot = {
  freshness: 'live',
  result: { checkedAt: '2026-08-18T12:00:00.000Z', status: 'verified' },
} as const;

describe('useProviderVerification', () => {
  beforeEach(() => {
    vi.mocked(fetchProviderVerification).mockReset();
  });

  it('stays idle until verify() is invoked — the probe is button-driven', () => {
    const { result } = renderHook(() => useProviderVerification('openai'));

    expect(result.current.lookup).toEqual({ state: 'idle' });
    expect(fetchProviderVerification).not.toHaveBeenCalled();
  });

  it('resolves the snapshot for the requested provider', async () => {
    vi.mocked(fetchProviderVerification).mockResolvedValue(snapshot);
    const { result } = renderHook(() => useProviderVerification('openai'));

    act(() => {
      result.current.verify();
    });
    expect(result.current.lookup).toEqual({ state: 'loading' });

    await waitFor(() => {
      expect(result.current.lookup).toEqual({ snapshot, state: 'resolved' });
    });
    expect(fetchProviderVerification).toHaveBeenCalledTimes(1);
    expect(fetchProviderVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        authHeaders: { 'x-test-auth': 'token' },
        baseUrl: 'http://127.0.0.1:51234',
        providerId: 'openai',
      })
    );
  });

  it('surfaces probe request failures as a bounded visible error', async () => {
    vi.mocked(fetchProviderVerification).mockRejectedValue(
      new Error('No credential configured for provider "openai".')
    );
    const { result } = renderHook(() => useProviderVerification('openai'));

    act(() => {
      result.current.verify();
    });

    await waitFor(() => {
      expect(result.current.lookup).toEqual({
        message: 'No credential configured for provider "openai".',
        state: 'error',
      });
    });
  });

  it('resets to idle when the provider changes', async () => {
    vi.mocked(fetchProviderVerification).mockResolvedValue(snapshot);
    const { rerender, result } = renderHook(
      ({ providerId }: { providerId: string }) => useProviderVerification(providerId),
      { initialProps: { providerId: 'openai' } }
    );

    act(() => {
      result.current.verify();
    });
    await waitFor(() => {
      expect(result.current.lookup.state).toBe('resolved');
    });

    rerender({ providerId: 'anthropic' });
    expect(result.current.lookup).toEqual({ state: 'idle' });
  });

  it('ignores a superseded in-flight request', async () => {
    let resolveFirst: ((value: typeof snapshot) => void) | undefined;
    vi.mocked(fetchProviderVerification)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        freshness: 'fresh-cache',
        result: { checkedAt: '2026-08-18T12:01:00.000Z', status: 'invalid' },
      });
    const { result } = renderHook(() => useProviderVerification('openai'));

    act(() => {
      result.current.verify();
    });
    act(() => {
      result.current.verify();
    });

    await waitFor(() => {
      expect(result.current.lookup.state).toBe('resolved');
    });
    resolveFirst?.(snapshot);
    await waitFor(() => {
      expect(result.current.lookup).toMatchObject({
        snapshot: { freshness: 'fresh-cache' },
        state: 'resolved',
      });
    });
  });
});
