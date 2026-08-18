import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { OPENAI_CODEX_RECOMMENDED_MODEL_IDS } from '@brainstrike/assistant-contract';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenAiCodexDefaults } from './use-openai-codex-model-defaults';
import { useProviderModelDefaults } from './use-provider-model-defaults';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useToast: () => ({ toast: toastMock }),
  };
});

/**
 * BST-1356. Migration 102 seeds every `openai-codex` catalog row
 * `is_enabled = false`, mirroring the openrouter and bedrock seeds. This hook
 * is WHERE enablement comes from — and it must be COMPOSED into
 * `useProviderModelDefaults`, or the provider is dead end to end: connect
 * succeeds, the provider reports configured, and the model picker shows
 * nothing.
 */
describe('useOpenAiCodexDefaults', () => {
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

  it('initializes the recommended set once a subscription account is connected', async () => {
    const { rerender } = renderHook(
      ({ secretsVersion }) => useOpenAiCodexDefaults(['openai-codex'], db, secretsVersion),
      { initialProps: { secretsVersion: 1 } }
    );

    await waitFor(() => expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1));
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(
      db,
      'openai-codex',
      OPENAI_CODEX_RECOMMENDED_MODEL_IDS
    );

    rerender({ secretsVersion: 1 });
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);
  });

  it.each([
    { configuredProviders: [], discoveryEnabled: true, providerReadError: undefined },
    {
      configuredProviders: ['openai-codex'],
      discoveryEnabled: false,
      providerReadError: undefined,
    },
    {
      configuredProviders: ['openai-codex'],
      discoveryEnabled: true,
      providerReadError: 'OS keychain is locked',
    },
  ])('does not initialize an ineligible provider state: %o', async (props) => {
    renderHook(() =>
      useOpenAiCodexDefaults(
        props.configuredProviders as 'openai-codex'[],
        db,
        1,
        props.discoveryEnabled,
        props.providerReadError ? { 'openai-codex': props.providerReadError } : undefined
      )
    );

    await Promise.resolve();
    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('surfaces initialization failures instead of silently degrading', async () => {
    initializeProviderModelDefaults.mockRejectedValueOnce(new Error('disk write failed'));

    renderHook(() => useOpenAiCodexDefaults(['openai-codex'], db, 1));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        description: 'disk write failed',
        title: 'OpenAI (ChatGPT) model setup failed',
        variant: 'destructive',
      })
    );
  });
});

/**
 * The composition seam itself. Without this the hook above is unreachable
 * production code — which is exactly the defect this test exists to catch.
 */
describe('useProviderModelDefaults composes the codex hook', () => {
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

  it('enables the codex rows through the shared seam when connected', async () => {
    renderHook(() => useProviderModelDefaults(['openai-codex'], db, 1, true));

    await waitFor(() =>
      expect(initializeProviderModelDefaults).toHaveBeenCalledWith(
        db,
        'openai-codex',
        OPENAI_CODEX_RECOMMENDED_MODEL_IDS
      )
    );
  });

  it('leaves the codex rows untouched when no account is connected', async () => {
    renderHook(() => useProviderModelDefaults(['openai'], db, 1, true));

    await Promise.resolve();
    expect(initializeProviderModelDefaults).not.toHaveBeenCalledWith(
      db,
      'openai-codex',
      expect.anything()
    );
  });
});
