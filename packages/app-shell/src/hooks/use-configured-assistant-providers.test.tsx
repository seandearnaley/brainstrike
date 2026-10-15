import {
  __resetAssistantPreferencesStoreForTests,
  AvailableProviderDiscoveryError,
  useAssistantPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-preferences-store';
import {
  __resetSecretsStoreForTests,
  useSecretsStore,
} from '@brainstrike/app-state/stores/secrets-store';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { FunctionComponent, PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  type AssistantProviderSource,
  AssistantProviderSourceProvider,
} from './assistant-provider-source';
import {
  __resetConfiguredAssistantProvidersForTests,
  useConfiguredAssistantProviders,
} from './use-configured-assistant-providers';

const originalGetAvailableProviders = useAssistantPreferencesStore.getState().getAvailableProviders;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!(resolvePromise && rejectPromise)) {
    throw new Error('Failed to initialize deferred provider discovery');
  }
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

function setProviderDiscovery(
  implementation: () => Promise<SupportedProvider[]>
): Mock<() => Promise<SupportedProvider[]>> {
  const getAvailableProviders = vi.fn(implementation);
  useAssistantPreferencesStore.setState({ getAvailableProviders });
  return getAvailableProviders;
}

function providerSourceWrapper(
  source: AssistantProviderSource
): FunctionComponent<PropsWithChildren> {
  return function ProviderSourceTestWrapper({ children }) {
    return (
      <AssistantProviderSourceProvider source={source}>{children}</AssistantProviderSourceProvider>
    );
  };
}

afterEach(() => {
  __resetConfiguredAssistantProvidersForTests();
  __resetAssistantPreferencesStoreForTests();
  useAssistantPreferencesStore.setState({
    getAvailableProviders: originalGetAvailableProviders,
  });
  __resetSecretsStoreForTests();
});

describe('useConfiguredAssistantProviders', () => {
  it('fails visibly when the provider source boundary is missing', () => {
    expect(() => renderHook(() => useConfiguredAssistantProviders())).toThrow(
      'AssistantProviderSourceProvider is required'
    );
  });

  it('merges Desktop seeds with one shared renderer discovery snapshot', async () => {
    const getAvailableProviders = setProviderDiscovery(async () => ['anthropic', 'ollama']);
    const source: AssistantProviderSource = {
      kind: 'discovery',
      seeds: ['openai', 'anthropic'],
    };

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper(source),
    });

    expect(result.current.providers).toEqual(['openai', 'anthropic']);
    await waitFor(() => {
      expect(result.current.providers).toEqual(['openai', 'anthropic', 'ollama']);
    });
    expect(getAvailableProviders).toHaveBeenCalledTimes(1);
  });

  it('keeps the merged Desktop provider list stable across unrelated renders', async () => {
    const pending = deferred<SupportedProvider[]>();
    const getAvailableProviders = setProviderDiscovery(() => pending.promise);
    const source: AssistantProviderSource = {
      kind: 'discovery',
      seeds: ['anthropic'],
    };

    const { rerender, result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper(source),
    });
    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(1));
    const providersBeforeRerender = result.current.providers;

    rerender();

    expect(result.current.providers).toBe(providersBeforeRerender);
    await act(async () => pending.resolve(['openrouter']));
  });

  it('treats Hosted Web providers as synchronous authority without discovery', async () => {
    const getAvailableProviders = setProviderDiscovery(async () => ['ollama']);
    const source: AssistantProviderSource = {
      kind: 'authoritative',
      providers: ['openai'],
    };

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper(source),
    });

    expect(result.current).toEqual({ discoveryState: 'inactive', providers: ['openai'] });
    await act(async () => Promise.resolve());
    expect(getAvailableProviders).not.toHaveBeenCalled();
  });

  it('refreshes discovery from the secrets-store event boundary', async () => {
    const getAvailableProviders = setProviderDiscovery(
      vi
        .fn<() => Promise<SupportedProvider[]>>()
        .mockResolvedValueOnce(['anthropic'])
        .mockResolvedValueOnce(['anthropic', 'openai'])
    );

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery' }),
    });
    await waitFor(() => expect(result.current.providers).toEqual(['anthropic']));

    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await waitFor(() => expect(result.current.providers).toEqual(['anthropic', 'openai']));
    expect(getAvailableProviders).toHaveBeenCalledTimes(2);
  });

  it('refreshes discovery only from local-runtime provider settings', async () => {
    const getAvailableProviders = setProviderDiscovery(
      vi
        .fn<() => Promise<SupportedProvider[]>>()
        .mockResolvedValueOnce(['anthropic'])
        .mockResolvedValueOnce(['anthropic', 'ollama'])
    );

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery' }),
    });
    await waitFor(() => expect(result.current.providers).toEqual(['anthropic']));

    await act(async () => {
      useAssistantPreferencesStore
        .getState()
        .setProviderSettings('openai', { reasoningEffort: 'high' });
      await Promise.resolve();
    });
    expect(getAvailableProviders).toHaveBeenCalledTimes(1);

    act(() => {
      useAssistantPreferencesStore
        .getState()
        .setProviderSettings('ollama', { localRuntimeEnabled: 'on' });
    });

    await waitFor(() => expect(result.current.providers).toEqual(['anthropic', 'ollama']));
    expect(getAvailableProviders).toHaveBeenCalledTimes(2);
  });

  it('preserves the last provider snapshot while a remount revalidates', async () => {
    const revalidation = deferred<SupportedProvider[]>();
    const getAvailableProviders = setProviderDiscovery(
      vi
        .fn<() => Promise<SupportedProvider[]>>()
        .mockResolvedValueOnce(['openrouter'])
        .mockImplementationOnce(() => revalidation.promise)
    );
    const source: AssistantProviderSource = { kind: 'discovery' };

    const firstMount = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper(source),
    });
    await waitFor(() => {
      expect(firstMount.result.current).toEqual({
        discoveryState: 'ready',
        providers: ['openrouter'],
      });
    });
    firstMount.unmount();

    const secondMount = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper(source),
    });
    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(2));
    expect(secondMount.result.current).toEqual({
      discoveryState: 'loading',
      providers: ['openrouter'],
    });

    await act(async () => revalidation.resolve(['openrouter', 'ollama']));
    await waitFor(() => {
      expect(secondMount.result.current).toEqual({
        discoveryState: 'ready',
        providers: ['openrouter', 'ollama'],
      });
    });
  });

  it('shares one discovery probe across multiple mounted consumers', async () => {
    const getAvailableProviders = setProviderDiscovery(async () => ['anthropic']);

    const { result } = renderHook(
      () => [useConfiguredAssistantProviders(), useConfiguredAssistantProviders()] as const,
      {
        wrapper: providerSourceWrapper({ kind: 'discovery' }),
      }
    );

    await waitFor(() => {
      expect(result.current[0].providers).toEqual(['anthropic']);
      expect(result.current[1].providers).toEqual(['anthropic']);
    });
    expect(getAvailableProviders).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest refresh result when an older request settles last', async () => {
    const first = deferred<SupportedProvider[]>();
    const second = deferred<SupportedProvider[]>();
    const getAvailableProviders = setProviderDiscovery(
      vi
        .fn<() => Promise<SupportedProvider[]>>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
    );

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery', seeds: ['anthropic'] }),
    });
    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(1));
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });
    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(['ollama']));
    await waitFor(() => expect(result.current.providers).toEqual(['anthropic', 'ollama']));

    await act(async () => first.resolve(['openai']));
    expect(result.current.providers).toEqual(['anthropic', 'ollama']);
  });

  it('keeps a prior test request invalid after the external resource is reset', async () => {
    const staleRequest = deferred<SupportedProvider[]>();
    const firstDiscovery = setProviderDiscovery(() => staleRequest.promise);
    const firstMount = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery' }),
    });
    await waitFor(() => expect(firstDiscovery).toHaveBeenCalledTimes(1));
    firstMount.unmount();

    __resetConfiguredAssistantProvidersForTests();
    const currentRequest = deferred<SupportedProvider[]>();
    const currentDiscovery = setProviderDiscovery(() => currentRequest.promise);
    let activeSource: AssistantProviderSource = {
      kind: 'authoritative',
      providers: ['anthropic'],
    };
    const SourceWrapper: FunctionComponent<PropsWithChildren> = ({ children }) => (
      <AssistantProviderSourceProvider source={activeSource}>
        {children}
      </AssistantProviderSourceProvider>
    );
    const { rerender, result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: SourceWrapper,
    });
    activeSource = { kind: 'discovery', seeds: ['anthropic'] };
    rerender();
    await waitFor(() => expect(currentDiscovery).toHaveBeenCalledTimes(1));

    await act(async () => staleRequest.resolve(['openrouter']));
    expect(result.current.providers).toEqual(['anthropic']);

    await act(async () => currentRequest.resolve(['anthropic']));
    await waitFor(() => expect(result.current.providers).toEqual(['anthropic']));
  });

  it('invalidates an in-flight Desktop request when authority switches to Hosted Web', async () => {
    const pending = deferred<SupportedProvider[]>();
    const getAvailableProviders = setProviderDiscovery(() => pending.promise);
    const desktopSource: AssistantProviderSource = {
      kind: 'discovery',
      seeds: ['anthropic'],
    };
    const hostedSource: AssistantProviderSource = {
      kind: 'authoritative',
      providers: ['openai'],
    };

    let activeSource: AssistantProviderSource = desktopSource;
    const SourceWrapper: FunctionComponent<PropsWithChildren> = ({ children }) => (
      <AssistantProviderSourceProvider source={activeSource}>
        {children}
      </AssistantProviderSourceProvider>
    );
    const { rerender, result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: SourceWrapper,
    });
    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(1));

    activeSource = hostedSource;
    rerender();
    expect(result.current.providers).toEqual(['openai']);
    await act(async () => pending.resolve(['ollama']));
    expect(result.current.providers).toEqual(['openai']);
  });

  it('surfaces discovery failures while retaining explicit Desktop seeds', async () => {
    setProviderDiscovery(async () => {
      throw new Error('OS keychain is locked');
    });

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery', seeds: ['anthropic'] }),
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        discoveryError: 'OS keychain is locked',
        discoveryState: 'error',
        providers: ['anthropic'],
      });
    });
  });

  it('surfaces a failed runtime probe while retaining independently discovered providers', async () => {
    setProviderDiscovery(async () => {
      throw new AvailableProviderDiscoveryError(
        [new Error('lmstudio discovery failed: probe crashed')],
        ['anthropic', 'ollama']
      );
    });

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery', seeds: ['openai'] }),
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        discoveryError: 'Provider discovery failed: lmstudio discovery failed: probe crashed',
        discoveryState: 'error',
        providers: ['openai', 'anthropic', 'ollama'],
      });
    });
  });
});
