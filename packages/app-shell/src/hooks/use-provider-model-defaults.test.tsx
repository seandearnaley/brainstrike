import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderModelDefaults } from './use-provider-model-defaults';

const initializeProviderModelDefaults = vi.fn(async () => 'initialized' as const);
const toast = vi.fn();

interface MockRegistryState {
  error: string | null;
  hasLoaded: boolean;
  initializeProviderModelDefaults: typeof initializeProviderModelDefaults;
}

// Mutable so guard-clause tests can flip `hasLoaded`/`error` between cases.
// The hook's entry guard is `hasLoaded && ... || registryError`: each
// conjunct must be independently mutation-tested, so a hardcoded literal
// here — which would make one clause unmutatable — would let deleting that
// clause pass with no test failing.
let registryState: MockRegistryState = {
  error: null,
  hasLoaded: true,
  initializeProviderModelDefaults,
};

vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (selector: (state: MockRegistryState) => unknown) =>
    selector(registryState),
}));
vi.mock('@brainstrike/ui', () => ({ useToast: () => ({ toast }) }));

const db = { query: vi.fn() } as never;

describe('useProviderModelDefaults', () => {
  beforeEach(() => {
    initializeProviderModelDefaults.mockClear();
    toast.mockClear();
    registryState = { error: null, hasLoaded: true, initializeProviderModelDefaults };
  });

  it('dispatches an availability policy for each first-party keyed provider', () => {
    renderHook(() => useProviderModelDefaults(['anthropic', 'google', 'openai'], db, 1, true));

    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(3);
    for (const provider of ['anthropic', 'google', 'openai']) {
      expect(initializeProviderModelDefaults).toHaveBeenCalledWith(db, provider, { kind: 'all' });
    }
  });

  it('dispatches the seed policy for openrouter, openai-codex and bedrock', () => {
    renderHook(() =>
      useProviderModelDefaults(['openrouter', 'openai-codex', 'bedrock'], db, 1, true)
    );

    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(3);
    for (const provider of ['openrouter', 'openai-codex', 'bedrock']) {
      expect(initializeProviderModelDefaults).toHaveBeenCalledWith(
        db,
        provider,
        expect.objectContaining({ kind: 'seed' })
      );
    }
  });

  it('dispatches nothing for a provider with no catalog defaults', () => {
    renderHook(() => useProviderModelDefaults(['ollama', 'voyage'], db, 1, true));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('dispatches nothing for a provider that is not configured', () => {
    renderHook(() => useProviderModelDefaults([], db, 1, true));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('dispatches once per db and secrets revision', () => {
    const { rerender } = renderHook(
      ({ version }: { version: number }) =>
        useProviderModelDefaults(['anthropic'], db, version, true),
      { initialProps: { version: 1 } }
    );
    rerender({ version: 1 });
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);

    rerender({ version: 2 });
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(2);
  });

  it('suppresses only the provider that reported a read error', () => {
    renderHook(() =>
      useProviderModelDefaults(['anthropic', 'openai'], db, 1, true, {
        anthropic: 'key unreadable',
      })
    );

    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(db, 'openai', { kind: 'all' });
  });

  it('raises a destructive toast naming the provider that failed', async () => {
    initializeProviderModelDefaults.mockRejectedValueOnce(new Error('db is closed'));

    renderHook(() => useProviderModelDefaults(['anthropic'], db, 1, true));
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());

    expect(toast).toHaveBeenCalledWith({
      description: 'db is closed',
      title: 'Anthropic model setup failed',
      variant: 'destructive',
    });
  });

  it('dispatches nothing while provider discovery is disabled', () => {
    renderHook(() => useProviderModelDefaults(['anthropic'], db, 1, false));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('dispatches nothing while the model registry has not finished loading', () => {
    registryState = { ...registryState, hasLoaded: false };

    renderHook(() => useProviderModelDefaults(['anthropic'], db, 1, true));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('dispatches nothing while the model registry reports an error', () => {
    registryState = { ...registryState, error: 'registry unavailable' };

    renderHook(() => useProviderModelDefaults(['anthropic'], db, 1, true));

    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });
});
