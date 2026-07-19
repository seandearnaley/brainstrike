import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_AVAILABILITY_OVERRIDE_EVENT,
  type AssistantAvailabilityStatus,
  type AssistantStatusFetcher,
  fetchAssistantStatusState,
  resolveAssistantStatusUrl,
  useAssistantAvailability,
} from '../hooks/use-assistant-availability';

describe('useAssistantAvailability', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, '__assistantAvailabilityOverride');
  });

  it('returns fetcher result', async () => {
    const fetcher = vi.fn<AssistantStatusFetcher>().mockResolvedValue({ state: 'enabled' });

    const { result } = renderHook(() => useAssistantAvailability(fetcher));

    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('enabled'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('maps fetcher errors to error state', async () => {
    const fetcher = vi.fn<AssistantStatusFetcher>().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useAssistantAvailability(fetcher));

    await waitFor(() => expect(result.current).toEqual({ message: 'boom', state: 'error' }));
  });

  it('reacts when the availability override is installed after mount', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<AssistantStatusFetcher>().mockImplementation((signal) => {
      signal.addEventListener('abort', () => controller.abort());
      return new Promise(() => undefined);
    });

    const { result } = renderHook(() => useAssistantAvailability(fetcher));

    expect(result.current.state).toBe('loading');

    act(() => {
      window.__assistantAvailabilityOverride = { state: 'enabled' };
      window.dispatchEvent(new Event(ASSISTANT_AVAILABILITY_OVERRIDE_EVENT));
    });

    await waitFor(() => expect(result.current).toEqual({ state: 'enabled' }));
    expect(controller.signal.aborted).toBe(true);
  });

  it('refetches when the availability override is removed', async () => {
    window.__assistantAvailabilityOverride = {
      reason: 'temporarily_disabled',
      state: 'disabled',
    };

    let resolveFetch: ((status: AssistantAvailabilityStatus) => void) | undefined;
    const fetcher = vi.fn<AssistantStatusFetcher>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const { result } = renderHook(() => useAssistantAvailability(fetcher));

    expect(result.current).toEqual({
      reason: 'temporarily_disabled',
      state: 'disabled',
    });
    expect(fetcher).not.toHaveBeenCalled();

    act(() => {
      Reflect.deleteProperty(window, '__assistantAvailabilityOverride');
      window.dispatchEvent(new Event(ASSISTANT_AVAILABILITY_OVERRIDE_EVENT));
    });

    expect(result.current).toEqual({ state: 'loading' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.({ state: 'enabled' });
    });

    expect(result.current).toEqual({ state: 'enabled' });
  });
});

describe('resolveAssistantStatusUrl', () => {
  const originalAssistant = (window as unknown as { assistant?: unknown }).assistant;

  afterEach(() => {
    (window as unknown as { assistant?: unknown }).assistant = originalAssistant;
  });

  it('returns default path when bridge is missing', async () => {
    (window as unknown as { assistant?: unknown }).assistant = undefined;

    await expect(resolveAssistantStatusUrl()).resolves.toBe('/api/assistant/status');
  });

  it('prefers async getUrl when provided', async () => {
    (window as unknown as { assistant?: { getUrl: () => Promise<string> } }).assistant = {
      async getUrl() {
        return 'https://bridge.example.com/';
      },
    };

    await expect(resolveAssistantStatusUrl()).resolves.toBe(
      'https://bridge.example.com/assistant/status'
    );
  });

  it('falls back to static url when getUrl fails', async () => {
    (
      window as unknown as { assistant?: { getUrl: () => Promise<string>; url: string } }
    ).assistant = {
      async getUrl() {
        throw new Error('fail');
      },
      url: 'https://fallback.example.com/',
    };

    await expect(resolveAssistantStatusUrl()).resolves.toBe(
      'https://fallback.example.com/assistant/status'
    );
  });
});

describe('fetchAssistantStatusState', () => {
  const originalAssistant = (window as unknown as { assistant?: unknown }).assistant;

  beforeEach(() => {
    (window as unknown as { assistant?: unknown }).assistant = undefined;
  });

  afterEach(() => {
    (window as unknown as { assistant?: unknown }).assistant = originalAssistant;
    vi.restoreAllMocks();
  });

  it('returns enabled status when backend is enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ enabled: true }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/assistant/status', {
      headers: { accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual<AssistantAvailabilityStatus>({ state: 'enabled' });
  });

  it('preserves an explicit hosted provider from the status endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        model: 'gpt-5.6-terra',
        provider: 'openai',
      }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(result).toEqual<AssistantAvailabilityStatus>({
      model: 'gpt-5.6-terra',
      provider: 'openai',
      state: 'enabled',
    });
  });

  it('rejects incomplete hosted runtime metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ enabled: true, provider: 'openai' }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Assistant status must advertise provider and model together');
  });

  it('rejects an unknown provider advertised by the status endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        model: 'unknown-model',
        provider: 'unknown-provider',
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Unsupported assistant provider: unknown-provider');
  });

  it('returns disabled state with reason', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ enabled: false, reason: 'missing_key' }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(result).toEqual<AssistantAvailabilityStatus>({
      reason: 'missing_key',
      state: 'disabled',
    });
  });

  it('throws on non-ok responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ enabled: false }),
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({ fetchImpl, signal: new AbortController().signal })
    ).rejects.toThrowError('status 500');
  });
});
