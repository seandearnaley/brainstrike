import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { BEDROCK_RECOMMENDED_MODEL_IDS } from '@brainstrike/assistant-contract';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBedrockDefaults } from './use-bedrock-model-defaults';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useToast: () => ({ toast: toastMock }),
  };
});

/**
 * BST-1350 review finding 8: bedrock's DB catalog rows ship is_enabled=false
 * (migration 100, mirroring the openrouter seed). This hook is WHERE
 * enablement comes from: the first readable bedrock configuration seeds the
 * recommended set through the same idempotent, choice-preserving
 * `initializeProviderModelDefaults` action openrouter uses — no hidden
 * asymmetry between the two keyed disabled-by-default providers.
 */
describe('useBedrockModelDefaults', () => {
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

  it('initializes the recommended bedrock set once a readable configuration is available', async () => {
    const { rerender } = renderHook(
      ({ secretsVersion }) => useBedrockDefaults(['bedrock'], db, secretsVersion),
      { initialProps: { secretsVersion: 1 } }
    );

    await waitFor(() => expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1));
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(
      db,
      'bedrock',
      BEDROCK_RECOMMENDED_MODEL_IDS
    );

    rerender({ secretsVersion: 1 });
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);
  });

  it.each([
    { configuredProviders: [], discoveryEnabled: true, providerReadError: undefined },
    {
      configuredProviders: ['bedrock'],
      discoveryEnabled: false,
      providerReadError: undefined,
    },
    {
      configuredProviders: ['bedrock'],
      discoveryEnabled: true,
      providerReadError: 'OS keychain is locked',
    },
  ])('does not initialize an ineligible provider state: %o', async (props) => {
    renderHook(() =>
      useBedrockDefaults(
        props.configuredProviders as 'bedrock'[],
        db,
        1,
        props.discoveryEnabled,
        props.providerReadError ? { bedrock: props.providerReadError } : undefined
      )
    );

    await Promise.resolve();
    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('surfaces initialization failures instead of silently degrading', async () => {
    initializeProviderModelDefaults.mockRejectedValueOnce(new Error('disk write failed'));

    renderHook(() => useBedrockDefaults(['bedrock'], db, 1));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        description: 'disk write failed',
        title: 'Amazon Bedrock model setup failed',
        variant: 'destructive',
      })
    );
  });
});
