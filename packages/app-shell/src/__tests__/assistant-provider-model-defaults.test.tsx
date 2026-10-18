import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  BoundaryFailureError,
  OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
  refusal,
  STATE_STORE_READ_ONLY_CODE,
} from '@brainstrike/assistant-contract';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantProviderModelDefaults } from '../assistant-provider-model-defaults';
import {
  type AssistantProviderSource,
  AssistantProviderSourceProvider,
} from '../hooks/assistant-provider-source';
import type { ConfiguredAssistantProviders } from '../hooks/use-configured-assistant-providers';

// Provider discovery is this owner's input; its probing has its own suite.
const configured = vi.hoisted((): { current: ConfiguredAssistantProviders } => ({
  current: { discoveryState: 'ready', providers: [] },
}));
vi.mock('../hooks/use-configured-assistant-providers', () => ({
  useConfiguredAssistantProviders: () => configured.current,
}));
// The renderer's open database; the registry counts as loaded, so nothing reads it.
const DATABASE = { kind: 'database' } as const;
vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db/react')>()),
  usePGliteDatabase: () => DATABASE,
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));

const registry = useModelRegistryStore.getState();
const initializeProviderModelDefaults = vi.fn<
  (...args: unknown[]) => Promise<'initialized' | 'preserved'>
>(async () => 'initialized');

function renderOwner(source: AssistantProviderSource): ReturnType<typeof render> {
  return render(
    <AssistantProviderSourceProvider source={source}>
      <AssistantProviderModelDefaults />
    </AssistantProviderSourceProvider>
  );
}

beforeEach(() => {
  useModelRegistryStore.setState({ error: null, hasLoaded: true, initializeProviderModelDefaults });
});

afterEach(() => {
  useModelRegistryStore.setState(registry, true);
  configured.current = { discoveryState: 'ready', providers: [] };
  initializeProviderModelDefaults.mockReset().mockResolvedValue('initialized');
  toast.mockClear();
});

describe('the one owner of first-configuration model defaults', () => {
  it("applies each configured provider's catalog policy once", () => {
    configured.current = { discoveryState: 'ready', providers: ['openrouter', 'openai'] };
    const owner = renderOwner({ kind: 'discovery' });
    owner.rerender(
      <AssistantProviderSourceProvider source={{ kind: 'discovery' }}>
        <AssistantProviderModelDefaults />
      </AssistantProviderSourceProvider>
    );
    expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(2);
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(DATABASE, 'openrouter', {
      kind: 'seed',
      modelIds: OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
    });
    expect(initializeProviderModelDefaults).toHaveBeenCalledWith(DATABASE, 'openai', {
      kind: 'all',
    });
  });

  it('applies nothing where the provider set is authoritative', () => {
    configured.current = { discoveryState: 'inactive', providers: ['openrouter'] };
    renderOwner({ kind: 'authoritative', providers: ['openrouter'] });
    expect(initializeProviderModelDefaults).not.toHaveBeenCalled();
  });

  it('waits quietly while the conversation store is read-only, and still reports any other failure (BST-2144)', async () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    initializeProviderModelDefaults.mockRejectedValueOnce(
      new BoundaryFailureError(
        refusal({
          category: 'availability',
          code: STATE_STORE_READ_ONLY_CODE,
          message: 'The conversation store is read-only.',
        })
      )
    );
    renderOwner({ kind: 'discovery' });
    await waitFor(() => {
      expect(initializeProviderModelDefaults).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();

    configured.current = { discoveryState: 'ready', providers: ['openrouter'] };
    initializeProviderModelDefaults.mockRejectedValueOnce(new Error('catalog unavailable'));
    renderOwner({ kind: 'discovery' });
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'catalog unavailable', variant: 'destructive' })
      );
    });
  });
});
