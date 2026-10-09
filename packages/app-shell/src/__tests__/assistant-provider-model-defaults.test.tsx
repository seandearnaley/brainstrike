import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { OPENROUTER_RECOMMENDED_CODING_MODEL_IDS } from '@brainstrike/assistant-contract';
import { render } from '@testing-library/react';
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

const registry = useModelRegistryStore.getState();
const initializeProviderModelDefaults = vi.fn(async () => 'initialized' as const);

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
  initializeProviderModelDefaults.mockClear();
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
});
