import {
  __resetSecretsStoreForTests,
  useSecretsStore,
} from '@brainstrike/app-state/stores/secrets-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_AVAILABILITY_OVERRIDE_EVENT,
  type AssistantAvailabilityStatus,
  type AssistantStatusFetcher,
  fetchAssistantStatusState,
  useAssistantAvailability,
} from '../hooks/use-assistant-availability';

describe('useAssistantAvailability', () => {
  beforeEach(() => {
    __resetSecretsStoreForTests();
  });

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

  it('refetches provider status when a stored secret changes', async () => {
    const fetcher = vi
      .fn<AssistantStatusFetcher>()
      .mockResolvedValueOnce({
        providerErrors: [
          {
            code: 'decrypt_failed',
            error: 'api_key_unreadable',
            message: 'Re-enter the OpenRouter key.',
            provider: 'openrouter',
          },
        ],
        state: 'enabled',
      })
      .mockResolvedValueOnce({ state: 'enabled' });

    const { result } = renderHook(() => useAssistantAvailability(fetcher));

    await waitFor(() =>
      expect(result.current).toMatchObject({
        providerErrors: [{ provider: 'openrouter' }],
        state: 'enabled',
      })
    );

    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    expect(result.current).toEqual({ state: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ state: 'enabled' }));
    expect(fetcher).toHaveBeenCalledTimes(2);
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

describe('fetchAssistantStatusState', () => {
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

  it('preserves strict desktop provider and key-source metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerKeySources: [
          {
            envVar: 'BRAINSTRIKE_OPENAI_API_KEY',
            provider: 'openai',
            source: 'env',
          },
          { provider: 'anthropic', source: 'stored' },
        ],
        providers: ['openai', 'anthropic', 'openai-codex'],
      }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(result).toEqual<AssistantAvailabilityStatus>({
      providerKeySources: [
        {
          envVar: 'BRAINSTRIKE_OPENAI_API_KEY',
          provider: 'openai',
          source: 'env',
        },
        { provider: 'anthropic', source: 'stored' },
      ],
      providers: ['openai', 'anthropic', 'openai-codex'],
      state: 'enabled',
    });
  });

  it('preserves validated deprecated env-var rename reports on an enabled status (BST-1361)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        deprecatedEnvVars: [
          { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ],
        enabled: true,
        providerKeySources: [],
        providers: ['openai-codex'],
      }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(result).toEqual<AssistantAvailabilityStatus>({
      deprecatedEnvVars: [
        { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
      ],
      providerKeySources: [],
      providers: ['openai-codex'],
      state: 'enabled',
    });
  });

  it('preserves deprecated env-var rename reports on a disabled status (BST-1361)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        deprecatedEnvVars: [
          {
            envVar: 'GOOGLE_API_KEY',
            provider: 'google',
            replacement: 'GOOGLE_GENERATIVE_AI_API_KEY',
          },
        ],
        enabled: false,
        reason: 'missing_api_key',
      }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(result).toEqual<AssistantAvailabilityStatus>({
      deprecatedEnvVars: [
        {
          envVar: 'GOOGLE_API_KEY',
          provider: 'google',
          replacement: 'GOOGLE_GENERATIVE_AI_API_KEY',
        },
      ],
      reason: 'missing_api_key',
      state: 'disabled',
    });
  });

  it('carries deprecated env-var reports alongside a configuration failure (BST-1361 review 5)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        deprecatedEnvVars: [
          { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ],
        enabled: false,
        envFileFailures: [
          {
            code: 'env_file_invalid',
            file: 'dev-local',
            message: 'Desktop environment file "dev-local" is invalid at line 2.',
          },
        ],
        error: 'assistant_configuration_invalid',
        message: 'Desktop environment configuration is invalid.',
        providers: [],
      }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(result).toEqual<AssistantAvailabilityStatus>({
      deprecatedEnvVars: [
        { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
      ],
      envFileFailures: [
        {
          code: 'env_file_invalid',
          file: 'dev-local',
          message: 'Desktop environment file "dev-local" is invalid at line 2.',
        },
      ],
      message: 'Desktop environment configuration is invalid.',
      state: 'error',
    });
  });

  it.each([
    ['a non-array report list', { deprecatedEnvVars: {} }],
    [
      'a report whose envVar is not a registry-deprecated name for its provider',
      {
        deprecatedEnvVars: [
          { envVar: 'OPENAI_API_KEY', provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ],
      },
    ],
    [
      'a report whose envVar belongs to a different provider',
      {
        deprecatedEnvVars: [
          { envVar: 'GOOGLE_API_KEY', provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ],
      },
    ],
    [
      'a report missing its replacement',
      { deprecatedEnvVars: [{ envVar: 'X', provider: 'openai' }] },
    ],
    [
      'a report for an unknown provider',
      { deprecatedEnvVars: [{ envVar: 'X', provider: 'mystery', replacement: 'Y' }] },
    ],
    [
      'a report with an extra field',
      {
        deprecatedEnvVars: [
          { envVar: 'X', extra: true, provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ],
      },
    ],
  ])('rejects %s (BST-1361)', async (_label, extraPayload) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerKeySources: [],
        providers: ['openai-codex'],
        ...extraPayload,
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError(/Invalid assistant deprecated env var report/);
  });

  it.each([
    ['a non-array source list', { providerKeySources: {} }],
    [
      'a duplicate provider',
      {
        providerKeySources: [
          { provider: 'openai', source: 'stored' },
          { provider: 'openai', source: 'stored' },
        ],
      },
    ],
    [
      'an env source without an env variable',
      { providerKeySources: [{ provider: 'openai', source: 'env' }] },
    ],
    [
      'an env variable for the wrong provider',
      {
        providerKeySources: [{ envVar: 'ANTHROPIC_API_KEY', provider: 'openai', source: 'env' }],
      },
    ],
    [
      'an env variable on a stored source',
      {
        providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'stored' }],
      },
    ],
    [
      'an extra source field',
      {
        providerKeySources: [{ provider: 'openai', source: 'stored', unexpected: true }],
      },
    ],
  ])('rejects %s', async (_label, extraPayload) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providers: ['openai', 'openai-codex'],
        ...extraPayload,
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError(/Invalid assistant provider key source/);
  });

  it('rejects duplicate available providers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerKeySources: [],
        providers: ['openai', 'openai'],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Invalid assistant provider list');
  });

  it('rejects an available hosted provider without a registry default model', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerKeySources: [{ provider: 'cohere', source: 'stored' }],
        providers: ['cohere'],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Assistant status provider cohere has no registry default model');
  });

  it('rejects an enabled status with an empty provider list', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ enabled: true, providerKeySources: [], providers: [] }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Enabled assistant status must include an available provider');
  });

  it('rejects a hosted provider without matching key-source metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerKeySources: [],
        providers: ['openai', 'openai-codex'],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Assistant hosted provider is missing its key source');
  });

  it('rejects a key source omitted from the available provider list', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerKeySources: [{ provider: 'openai', source: 'stored' }],
        providers: ['openai-codex'],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Assistant provider key source is missing from providers');
  });

  it('rejects a provider advertised as both available and unreadable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerErrors: [
          {
            code: 'decrypt_failed',
            error: 'api_key_unreadable',
            message: 'Stored key is unreadable.',
            provider: 'openai',
          },
        ],
        providerKeySources: [],
        providers: ['openai', 'openai-codex'],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Assistant provider cannot be both available and unreadable');
  });

  it('rejects unknown root status fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ enabled: true, providers: ['openai-codex'], unexpected: true }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Invalid assistant status payload');
  });

  it('preserves a strict desktop environment configuration failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: false,
        envFileFailures: [
          {
            code: 'env_file_invalid',
            file: 'dev-local',
            message: 'Desktop environment file dev-local is invalid at line 2.',
          },
        ],
        error: 'assistant_configuration_invalid',
        message: 'Desktop environment configuration is invalid.',
        providers: [],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      envFileFailures: [
        {
          code: 'env_file_invalid',
          file: 'dev-local',
          message: 'Desktop environment file dev-local is invalid at line 2.',
        },
      ],
      message: 'Desktop environment configuration is invalid.',
      state: 'error',
    });
  });

  it('rejects malformed desktop environment configuration failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: false,
        envFileFailures: [
          {
            code: 'env_file_invalid',
            file: 'dev-local',
            message: 'Desktop environment file dev-local is invalid.',
            secretValue: 'must-not-cross',
          },
        ],
        error: 'assistant_configuration_invalid',
        message: 'Desktop environment configuration is invalid.',
        providers: [],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Invalid assistant environment file failure');
  });

  it('preserves validated provider read errors from an enabled desktop status', async () => {
    const providerError = {
      code: 'decrypt_failed',
      error: 'api_key_unreadable',
      message: 'Stored OpenRouter key is unreadable. Re-enter the key to repair it.',
      provider: 'openrouter',
    } as const;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ enabled: true, providerErrors: [providerError] }),
      ok: true,
    } as unknown as Response);

    const result = await fetchAssistantStatusState({
      fetchImpl,
      signal: new AbortController().signal,
    });

    expect(result).toEqual<AssistantAvailabilityStatus>({
      providerErrors: [providerError],
      state: 'enabled',
    });
  });

  it('rejects malformed provider read errors instead of guessing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        enabled: true,
        providerErrors: [{ error: 'api_key_unreadable', provider: 'unknown' }],
      }),
      ok: true,
    } as unknown as Response);

    await expect(
      fetchAssistantStatusState({
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError('Invalid assistant provider error');
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
