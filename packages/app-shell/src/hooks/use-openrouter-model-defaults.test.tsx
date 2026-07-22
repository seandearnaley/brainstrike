import { OPENROUTER_RECOMMENDED_CODING_MODEL_IDS } from '@brainstrike/assistant-contract';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/preferences/stores/model-registry-store';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenRouterDefaults } from './use-openrouter-model-defaults';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useToast: () => ({ toast: toastMock }),
  };
});

describe('useOpenRouterModelDefaults', () => {
  const db = { query: vi.fn() } as never;
  const initializeProviderModelDefaults = vi.fn().mockResolvedValue('initialized');

  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    toastMock.mockReset();
    initializeProviderModelDefaults.mockReset().mockResolvedValue('initialized');
    useModelRegistryStore.setState({
      error: null,
      hasLoaded: true,
      initializeProviderModelDefaults,
    });
  });

  it('initializes the curated coding set once a readable configuration is available', async () => {
    const { rerender } = renderHook(
      ({ secretsVersion }) => useOpenRouterDefaults(['openrouter'], db, secretsVersion),
      { initialProps: { secretsVersion: 1 } }
    );

    await waitFor(() => expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1));
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(
      db,
      'openrouter',
      OPENROUTER_RECOMMENDED_CODING_MODEL_IDS
    );

    rerender({ secretsVersion: 1 });
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);
  });

  it.each([
    { configuredProviders: [], initialProviders: undefined, providerReadError: undefined },
    {
      configuredProviders: ['openrouter'],
      initialProviders: ['openai'],
      providerReadError: undefined,
    },
    {
      configuredProviders: ['openrouter'],
      initialProviders: undefined,
      providerReadError: 'OS keychain is locked',
    },
  ])('does not initialize an ineligible provider state: %o', async (props) => {
    renderHook(() =>
      useOpenRouterDefaults(
        props.configuredProviders as 'openrouter'[],
        db,
        1,
        props.initialProviders,
        props.providerReadError ? { openrouter: props.providerReadError } : undefined
      )
    );

    await Promise.resolve();
    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('surfaces initialization failures instead of silently degrading', async () => {
    initializeProviderModelDefaults.mockRejectedValueOnce(new Error('disk write failed'));

    renderHook(() => useOpenRouterDefaults(['openrouter'], db, 1));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        description: 'disk write failed',
        title: 'OpenRouter model setup failed',
        variant: 'destructive',
      })
    );
  });
});
