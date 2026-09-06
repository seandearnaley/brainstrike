import {
  __resetSecretsStoreForTests,
  useSecretsStore,
} from '@brainstrike/app-state/stores/secrets-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCredentialSources } from '../use-credential-sources';

interface SecretsApi {
  readonly list: () => Promise<unknown>;
}

function installSecretsBridge(list: () => Promise<unknown>): void {
  Object.defineProperty(window, 'secrets', {
    configurable: true,
    value: { list } satisfies SecretsApi,
    writable: true,
  });
}

function removeSecretsBridge(): void {
  (window as unknown as Record<string, unknown>)['secrets'] = undefined;
}

beforeEach(() => {
  __resetSecretsStoreForTests();
});

afterEach(() => {
  removeSecretsBridge();
  vi.restoreAllMocks();
});

describe('useCredentialSources', () => {
  it('loads the listing and indexes the winning source per slot', async () => {
    installSecretsBridge(() =>
      Promise.resolve([
        { provider: 'openai', source: 'stored' },
        { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic', source: 'env' },
      ])
    );

    const { result } = renderHook(() => useCredentialSources());

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.sourcesBySlotId.get('openai')?.source).toBe('stored');
    expect(result.current.sourcesBySlotId.get('anthropic')?.source).toBe('env');
    expect(result.current.sourcesBySlotId.has('google')).toBe(false);
    expect(result.current.editable).toBe(true);
  });

  it('re-reads the listing when a credential changes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ provider: 'openai', source: 'stored' }]);
    installSecretsBridge(list);

    const { result } = renderHook(() => useCredentialSources());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.sourcesBySlotId.size).toBe(0);

    // This is the signal the inventory fires after a successful save.
    act(() => {
      useSecretsStore.getState().notifySecretsChanged();
    });

    await waitFor(() =>
      expect(result.current.sourcesBySlotId.get('openai')?.source).toBe('stored')
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed listing instead of reporting every provider as not set', async () => {
    installSecretsBridge(() => Promise.reject(new Error('keychain locked')));

    const { result } = renderHook(() => useCredentialSources());

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toContain('keychain locked');
    expect(result.current.sourcesBySlotId.size).toBe(0);
  });

  it('reports a malformed payload rather than silently dropping rows', async () => {
    installSecretsBridge(() => Promise.resolve([{ provider: 'openai', source: 'nonsense' }]));

    const { result } = renderHook(() => useCredentialSources());

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error.length).toBeGreaterThan(0);
  });

  it('reports "unavailable" — not "ready" — when there is no bridge AND no status payload', async () => {
    // This is the REAL web wiring: no `window.secrets`, and the settings page
    // passes no status sources. Reporting `ready` here would turn "we have no
    // source of truth" into "every provider is disconnected".
    const { result } = renderHook(() => useCredentialSources());

    await waitFor(() => expect(result.current.state).toBe('unavailable'));
    expect(result.current.editable).toBe(false);
    expect(result.current.sourcesBySlotId.size).toBe(0);
  });

  it('runs read-only off the status payload when no secrets bridge exists (web)', async () => {
    const statusSources: readonly ProviderKeySource<SupportedProvider>[] = [
      { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
    ];

    const { result } = renderHook(() => useCredentialSources(statusSources));

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.editable).toBe(false);
    expect(result.current.sourcesBySlotId.get('openai')?.source).toBe('env');
  });

  it('lets an env source from the status probe win over a stored listing entry', async () => {
    installSecretsBridge(() => Promise.resolve([{ provider: 'openai', source: 'stored' }]));
    const statusSources: readonly ProviderKeySource<SupportedProvider>[] = [
      { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
    ];

    const { result } = renderHook(() => useCredentialSources(statusSources));

    await waitFor(() => expect(result.current.state).toBe('ready'));
    // Env is authoritative at runtime; the card must name what will actually
    // sign the next request.
    expect(result.current.sourcesBySlotId.get('openai')?.source).toBe('env');
  });
});
