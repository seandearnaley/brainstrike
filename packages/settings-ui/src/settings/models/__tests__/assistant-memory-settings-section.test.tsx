import '@testing-library/jest-dom/vitest';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantMemorySettingsSection,
  type AssistantMemorySettingsSectionProps,
} from '../assistant-memory-settings-section';

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

function seedRegistry(): void {
  useModelRegistryStore.setState({
    error: null,
    hasLoaded: true,
    isLoading: false,
    models: [
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'gpt-5.4-mini',
        isEnabled: true,
        name: 'GPT-5.4 Mini',
        parameters: null,
        providerId: 'openai',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'claude-haiku-4-5',
        isEnabled: true,
        name: 'Claude Haiku 4.5',
        parameters: null,
        providerId: 'anthropic',
        sortOrder: 1,
        tagline: null,
      },
      {
        bestFor: null,
        capabilities: { streaming: true, type: 'llm' },
        description: null,
        icon: null,
        id: 'openai/gpt-5.2',
        isEnabled: true,
        name: 'GPT-5.2 via OpenRouter',
        parameters: null,
        providerId: 'openrouter',
        sortOrder: 1,
        tagline: null,
      },
    ],
    providers: [
      { icon: null, id: 'openai', isEnabled: true, name: 'OpenAI', sortOrder: 1 },
      { icon: null, id: 'anthropic', isEnabled: true, name: 'Anthropic', sortOrder: 2 },
      { icon: null, id: 'openrouter', isEnabled: false, name: 'OpenRouter', sortOrder: 4 },
    ],
  });
}

const hostedProviderKeySources = [
  { provider: 'openai', source: 'stored' },
  { provider: 'anthropic', source: 'stored' },
] as const;

function renderMemorySettings(
  providerKeySources: AssistantMemorySettingsSectionProps['providerKeySources'] = hostedProviderKeySources,
  assistantMemoryBackendAvailable = true
): ReturnType<typeof render> {
  return render(
    <AssistantMemorySettingsSection
      assistantMemoryBackendAvailable={assistantMemoryBackendAvailable}
      providerKeySources={providerKeySources}
    />
  );
}

describe('AssistantMemorySettingsSection', () => {
  beforeEach(() => {
    seedRegistry();
  });

  it('lists only enabled LLM models for observational memory', () => {
    renderMemorySettings();

    const select = screen.getByRole('combobox', { name: /observational memory model/iu });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/iu })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Claude Haiku 4.5/iu })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /OpenRouter/iu })).toBeNull();
  });

  it('filters observer models by key presence', () => {
    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    const select = screen.getByRole('combobox', { name: /observational memory model/iu });
    expect(within(select).getByRole('option', { name: /GPT-5.4 Mini/iu })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Claude Haiku 4.5/iu })).toBeNull();
  });

  it('does not filter memory models when credential provenance is unavailable', () => {
    render(<AssistantMemorySettingsSection assistantMemoryBackendAvailable={true} />);

    expect(
      within(screen.getByRole('combobox', { name: /observational memory model/iu })).getByRole(
        'option',
        { name: /GPT-5.4 Mini/iu }
      )
    ).toBeInTheDocument();
  });

  // Observational memory needs the durable backend to record anything, so with
  // no backend there is no eligible observer AT ALL.
  it('offers no observer model when the memory backend is unavailable', () => {
    renderMemorySettings(hostedProviderKeySources, false);

    const select = screen.getByRole('combobox', { name: /observational memory model/iu });
    expect(within(select).queryByRole('option', { name: /GPT-5.4 Mini/iu })).toBeNull();
    expect(within(select).queryByRole('option', { name: /Claude Haiku 4.5/iu })).toBeNull();
    // The 'auto' sentinel still renders, and the section's own unresolved
    // notice explains the wait: OM is never silently off.
    expect(within(select).getByRole('option', { name: /Auto —/iu })).toBeInTheDocument();
  });

  it('does not claim credentials are missing before the model registry loads', () => {
    useModelRegistryStore.setState({ hasLoaded: false, models: [], providers: [] });

    renderMemorySettings([]);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables observation activation and alerts when the selected provider has no key', () => {
    // User turned observations OFF and pinned an explicit model whose provider
    // has no key — re-activation stays blocked until the target is available.
    // (The default 'auto' target never blocks the toggle; see the BST-940 case.)
    useAssistantMemoryPreferencesStore.setState((state) => ({
      observationalMemory: {
        ...state.observationalMemory,
        enabled: false,
        modelTarget: 'anthropic/claude-haiku-4-5',
      },
    }));

    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    expect(screen.getByRole('switch', { name: 'Enable observational memory' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Configure its API key in Settings → Providers'
    );
  });

  it('keeps the toggle usable on the default auto target and explains the privacy rule (BST-940)', () => {
    renderMemorySettings([{ provider: 'anthropic', source: 'stored' }]);

    const toggle = screen.getByRole('switch', { name: 'Enable observational memory' });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox', { name: /observational memory model/iu })).toHaveValue(
      'auto'
    );
    const note = screen.getByTestId('assistant-memory-auto-observer-note');
    // The privacy ruling: auto observes with the ACTIVE CHAT PROVIDER only,
    // never a different keyed provider.
    expect(note).toHaveTextContent(/active chat provider only/iu);
  });

  it('keeps the auto note and toggle stable for a profile with no keys (waiting, not broken)', () => {
    renderMemorySettings([]);

    expect(screen.getByRole('switch', { name: 'Enable observational memory' })).toBeEnabled();
    expect(screen.getByTestId('assistant-memory-auto-observer-note')).toHaveTextContent(
      /active chat provider only/iu
    );
  });

  it('persists selected observational memory settings', async () => {
    const user = userEvent.setup();
    renderMemorySettings();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /observational memory model/iu }),
      'anthropic/claude-haiku-4-5'
    );
    await user.clear(screen.getByRole('spinbutton', { name: /observe messages after/iu }));
    await user.type(screen.getByRole('spinbutton', { name: /observe messages after/iu }), '18000');
    await user.tab();

    expect(useAssistantMemoryPreferencesStore.getState().observationalMemory).toMatchObject({
      messageTokens: 18_000,
      modelTarget: 'anthropic/claude-haiku-4-5',
    });
  });

  it('offers raw message recall as the only observation retrieval', () => {
    renderMemorySettings();

    const select = screen.getByRole('combobox', { name: 'Observation retrieval mode' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Off', 'Raw message recall']);
  });

  it('says how to fix an observer whose provider has no key', () => {
    useAssistantMemoryPreferencesStore.setState((state) => ({
      observationalMemory: {
        ...state.observationalMemory,
        enabled: false,
        modelTarget: 'anthropic/claude-haiku-4-5',
      },
    }));
    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    const section = screen.getByTestId('assistant-memory-settings-section');
    expect(section).not.toHaveTextContent(/assistant startup fails/iu);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Configure its API key in Settings → Providers, choose an observer whose provider has a key, or turn observations off.'
    );
  });

  describe('number inputs', () => {
    // An entry out of range is refused under its field when committed and saves
    // nothing; the old setters clamped it to the nearest bound and saved that.
    it.each([
      ['Observe messages after', '500', 'Enter a whole number of at least 1,000.'],
      ['Reflect observations after', '1500.5', 'Enter a whole number of at least 1,000.'],
      ['Observe messages after', '', 'Enter a whole number of at least 1,000.'],
    ])('%s refuses %j visibly and saves nothing', async (name, typed, message) => {
      const user = userEvent.setup();
      const before = useAssistantMemoryPreferencesStore.getState();
      renderMemorySettings();

      const input = screen.getByRole('spinbutton', { name });
      await user.clear(input);
      if (typed) {
        await user.type(input, typed);
      }
      await user.keyboard('{Enter}');

      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(message);
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      const after = useAssistantMemoryPreferencesStore.getState();
      expect(after.observationalMemory).toEqual(before.observationalMemory);
    });

    it('saves a valid value on blur, never the keystrokes on the way, and clears the error', async () => {
      const user = userEvent.setup();
      renderMemorySettings();
      const before =
        useAssistantMemoryPreferencesStore.getState().observationalMemory.messageTokens;

      const input = screen.getByRole('spinbutton', { name: 'Observe messages after' });
      await user.clear(input);
      await user.type(input, '20');
      await user.keyboard('{Enter}');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      // Typing "2000" passes through "20"; a draft is not a value.
      expect(useAssistantMemoryPreferencesStore.getState().observationalMemory.messageTokens).toBe(
        before
      );
      await user.clear(input);
      await user.type(input, '2000');
      await user.tab();

      expect(input).not.toHaveAttribute('aria-invalid');
      expect(input).not.toHaveAccessibleDescription();
      expect(useAssistantMemoryPreferencesStore.getState().observationalMemory.messageTokens).toBe(
        2000
      );
    });
  });

  describe('manual observer egress disclosure', () => {
    const chooseObserver = (target: string) => {
      useAssistantMemoryPreferencesStore.setState((state) => ({
        observationalMemory: { ...state.observationalMemory, modelTarget: target },
      }));
    };

    it('states that a MANUAL target is not tied to the chat provider', () => {
      // Auto carries an enforced guarantee in its own copy — "the conversation
      // never reaches a provider that is not already receiving it" (BST-940).
      // A manual target has no such constraint and said nothing about egress,
      // so a reader of the auto note would assume it still held. Observed live
      // across two debug bundles: chat on openrouter, observer on
      // openai/gpt-5.6-luna.
      chooseObserver('openai/gpt-5.4-mini');
      renderMemorySettings();

      const note = screen.getByTestId('assistant-memory-manual-observer-note');
      expect(note).toHaveTextContent(/not tied to your chat provider/iu);
      expect(note).toHaveTextContent(/reaches the observer's provider/iu);
    });

    it('does NOT claim it on Auto, which cannot cross by construction', () => {
      chooseObserver('auto');
      renderMemorySettings();

      expect(screen.queryByTestId('assistant-memory-manual-observer-note')).toBeNull();
      expect(screen.getByTestId('assistant-memory-auto-observer-note')).toHaveTextContent(
        /never reaches a provider that is not already receiving it/iu
      );
    });

    it('states it unconditionally, not per active thread', () => {
      // The observer target is GLOBAL; the chat provider is per-thread
      // (`draftRuntimeByThreadId` wins over the global `selectedModel` in
      // assistant-ui-panel-wrapper). A disclosure keyed to whichever thread
      // happened to be active would go silent for every OTHER thread — wrong
      // in the direction that matters, since the setting governs all of them.
      // So it describes the setting, and does not read any provider at all.
      chooseObserver('anthropic/claude-haiku-4-5');
      renderMemorySettings();

      expect(screen.getByTestId('assistant-memory-manual-observer-note')).toHaveTextContent(
        /not tied to your chat provider/iu
      );
    });
  });
});
