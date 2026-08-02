import {
  __resetAssistantPreferencesStoreForTests,
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
    const getAvailableProviders = setProviderDiscovery(async () => ['local', 'ollama']);
    const source: AssistantProviderSource = {
      kind: 'discovery',
      seeds: ['openai', 'local'],
    };

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper(source),
    });

    expect(result.current.providers).toEqual(['openai', 'local']);
    await waitFor(() => {
      expect(result.current.providers).toEqual(['openai', 'local', 'ollama']);
    });
    expect(getAvailableProviders).toHaveBeenCalledTimes(1);
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

    expect(result.current).toEqual({ providers: ['openai'] });
    await act(async () => Promise.resolve());
    expect(getAvailableProviders).not.toHaveBeenCalled();
  });

  it('refreshes discovery from the secrets-store event boundary', async () => {
    const getAvailableProviders = setProviderDiscovery(
      vi
        .fn<() => Promise<SupportedProvider[]>>()
        .mockResolvedValueOnce(['local'])
        .mockResolvedValueOnce(['local', 'openai'])
    );

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery' }),
    });
    await waitFor(() => expect(result.current.providers).toEqual(['local']));

    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await waitFor(() => expect(result.current.providers).toEqual(['local', 'openai']));
    expect(getAvailableProviders).toHaveBeenCalledTimes(2);
  });

  it('refreshes discovery from the provider-settings event boundary', async () => {
    const getAvailableProviders = setProviderDiscovery(
      vi
        .fn<() => Promise<SupportedProvider[]>>()
        .mockResolvedValueOnce(['local'])
        .mockResolvedValueOnce(['local', 'ollama'])
    );

    const { result } = renderHook(() => useConfiguredAssistantProviders(), {
      wrapper: providerSourceWrapper({ kind: 'discovery' }),
    });
    await waitFor(() => expect(result.current.providers).toEqual(['local']));

    act(() => {
      useAssistantPreferencesStore
        .getState()
        .setProviderSettings('ollama', { localRuntimeEnabled: 'on' });
    });

    await waitFor(() => expect(result.current.providers).toEqual(['local', 'ollama']));
    expect(getAvailableProviders).toHaveBeenCalledTimes(2);
  });

  it('shares one discovery probe across multiple mounted consumers', async () => {
    const getAvailableProviders = setProviderDiscovery(async () => ['local']);

    const { result } = renderHook(
      () => [useConfiguredAssistantProviders(), useConfiguredAssistantProviders()] as const,
      {
        wrapper: providerSourceWrapper({ kind: 'discovery' }),
      }
    );

    await waitFor(() => {
      expect(result.current[0].providers).toEqual(['local']);
      expect(result.current[1].providers).toEqual(['local']);
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
      wrapper: providerSourceWrapper({ kind: 'discovery', seeds: ['local'] }),
    });
    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(1));
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });
    await waitFor(() => expect(getAvailableProviders).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(['ollama']));
    await waitFor(() => expect(result.current.providers).toEqual(['local', 'ollama']));

    await act(async () => first.resolve(['openai']));
    expect(result.current.providers).toEqual(['local', 'ollama']);
  });

  it('invalidates an in-flight Desktop request when authority switches to Hosted Web', async () => {
    const pending = deferred<SupportedProvider[]>();
    const getAvailableProviders = setProviderDiscovery(() => pending.promise);
    const desktopSource: AssistantProviderSource = {
      kind: 'discovery',
      seeds: ['local'],
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
      wrapper: providerSourceWrapper({ kind: 'discovery', seeds: ['local'] }),
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        discoveryError: 'OS keychain is locked',
        providers: ['local'],
      });
    });
  });
});
