import type { useConfiguredAssistantProviders } from '@brainstrike/app-shell';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { getProviderModelDefinitions } from '@brainstrike/assistant-contract';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useDesktopHostPresentation } from '../renderer/use-desktop-host-presentation';

// The provider list is this hook's input (the shared discovery resource owns
// it); slash commands and @-mentions need the explorer and file-system shells
// and take no part in the composer's provider notice.
type ConfiguredProviders = ReturnType<typeof useConfiguredAssistantProviders>;
const configured = vi.hoisted((): { current: ConfiguredProviders } => ({
  current: { discoveryState: 'ready', providers: [] },
}));
vi.mock('@brainstrike/app-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/app-shell')>()),
  useAssistantSlashCommands: () => [],
  useConfiguredAssistantProviders: () => configured.current,
  useFileMentions: () => ({ fileMentions: [] }),
}));

const THREAD = 'host-thread-presentation';
const openAiModel = getProviderModelDefinitions('openai').find((model) => model.type === 'llm');
if (!openAiModel) {
  throw new Error('The provider catalog lists no OpenAI chat model');
}
const registryRow = (isEnabled: boolean) => ({
  bestFor: null,
  capabilities: { type: 'llm' as const },
  description: null,
  icon: null,
  id: openAiModel.id,
  isEnabled,
  name: openAiModel.label ?? openAiModel.id,
  parameters: null,
  providerId: 'openai',
  sortOrder: 0,
  tagline: null,
});

const preferences = useAssistantPreferencesStore.getState();
const registry = useModelRegistryStore.getState();
const threads = useAssistantThreadStore.getState();

beforeEach(() => {
  useAssistantPreferencesStore.setState({ selectedModel: `openai::${openAiModel.id}` });
});

afterEach(() => {
  useAssistantPreferencesStore.setState(preferences, true);
  useModelRegistryStore.setState(registry, true);
  useAssistantThreadStore.setState(threads, true);
  configured.current = { discoveryState: 'ready', providers: [] };
});

describe('the host composer gates a send on the provider notice', () => {
  test('no connected provider', () => {
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'Connect an AI provider in Settings → Providers to enable the assistant.'
    );
    expect(result.current.isComposerDisabled).toBe(true);
    expect(() => result.current.readConfiguration(null)).toThrow(
      'Connect an AI provider in Settings → Providers to enable the assistant.'
    );
  });

  test('a connected provider with no enabled model', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    useModelRegistryStore.setState({ models: [registryRow(false)] });
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe('Enable at least one model for OpenAI to continue.');
    expect(result.current.isComposerDisabled).toBe(true);
  });

  test('an unavailable local runtime', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    useAssistantPreferencesStore.setState({ selectedModel: 'ollama::llama3.2' });
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'The selected local runtime is currently unavailable.'
    );
    expect(result.current.isComposerDisabled).toBe(true);
  });

  test("the host status's credential read failure for the selected provider", () => {
    configured.current = { discoveryState: 'ready', providers: ['openai', 'anthropic'] };
    useModelRegistryStore.setState({ models: [registryRow(true)] });
    const { result } = renderHook(() =>
      useDesktopHostPresentation(THREAD, { openai: 'The OpenAI key could not be read.' })
    );
    expect(result.current.disabledReason).toBe('The OpenAI key could not be read.');
    expect(result.current.isComposerDisabled).toBe(true);
  });

  test('a failed provider refresh with nothing connected names the refresh', () => {
    configured.current = { discoveryError: 'probe failed', discoveryState: 'error', providers: [] };
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'Could not refresh available providers: probe failed'
    );
    expect(result.current.isComposerDisabled).toBe(true);
  });

  test('a failed refresh with a ready provider is shown without gating the send', () => {
    configured.current = {
      discoveryError: 'probe failed',
      discoveryState: 'error',
      providers: ['openai'],
    };
    useModelRegistryStore.setState({ models: [registryRow(true)] });
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBe(
      'Could not refresh available providers: probe failed'
    );
    expect(result.current.isComposerDisabled).toBeUndefined();
  });

  test('a ready provider and model leave the composer open', () => {
    configured.current = { discoveryState: 'ready', providers: ['openai'] };
    useModelRegistryStore.setState({ models: [registryRow(true)] });
    const { result } = renderHook(() => useDesktopHostPresentation(THREAD));
    expect(result.current.disabledReason).toBeUndefined();
    expect(result.current.isComposerDisabled).toBeUndefined();
  });
});
