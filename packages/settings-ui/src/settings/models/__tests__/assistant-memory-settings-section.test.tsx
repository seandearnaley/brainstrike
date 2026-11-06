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

/** The observer field: a combobox its label names. */
function observerField(): HTMLElement {
  return screen.getByRole('combobox', { name: /observational memory model/iu });
}

async function openObserverPicker(): Promise<HTMLElement> {
  await userEvent.setup().click(observerField());
  return screen.findByRole('dialog', { name: 'Choose a model' });
}

describe('AssistantMemorySettingsSection', () => {
  beforeEach(() => {
    seedRegistry();
  });

  it('lists only enabled LLM models for observational memory, each with its maker mark', async () => {
    renderMemorySettings();

    const picker = await openObserverPicker();
    expect(within(picker).getByRole('option', { name: /GPT-5.4 Mini/iu })).toBeInTheDocument();
    const haiku = within(picker).getByRole('option', { name: /Claude Haiku 4.5/iu });
    expect(within(haiku).getByRole('img', { name: 'Anthropic' })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /OpenRouter/iu })).toBeNull();
  });

  it('filters observer models by key presence', async () => {
    renderMemorySettings([{ provider: 'openai', source: 'stored' }]);

    const picker = await openObserverPicker();
    expect(within(picker).getByRole('option', { name: /GPT-5.4 Mini/iu })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Claude Haiku 4.5/iu })).toBeNull();
  });

  it('does not filter memory models when credential provenance is unavailable', async () => {
    render(<AssistantMemorySettingsSection assistantMemoryBackendAvailable={true} />);

    const picker = await openObserverPicker();
    expect(within(picker).getByRole('option', { name: /GPT-5.4 Mini/iu })).toBeInTheDocument();
  });

  // Observational memory needs the durable backend to record anything, so with
  // no backend there is no eligible observer AT ALL.
  it('offers no observer model when the memory backend is unavailable', async () => {
    renderMemorySettings(hostedProviderKeySources, false);

    const picker = await openObserverPicker();
    // Only the 'auto' sentinel renders: OM is never silently off.
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Auto (chat’s provider)']);
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

  it('keeps the toggle usable on the default auto target, which names the chat provider (BST-940)', () => {
    renderMemorySettings([{ provider: 'anthropic', source: 'stored' }]);

    const toggle = screen.getByRole('switch', { name: 'Enable observational memory' });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The privacy ruling lives in the option: Auto observes on the chat's own provider.
    expect(observerField()).toHaveTextContent('Auto (chat’s provider)');
  });

  it('keeps Auto and the toggle stable for a profile with no keys (waiting, not broken)', () => {
    renderMemorySettings([]);

    expect(screen.getByRole('switch', { name: 'Enable observational memory' })).toBeEnabled();
    expect(observerField()).toHaveTextContent('Auto (chat’s provider)');
  });

  it('persists selected observational memory settings', async () => {
    const user = userEvent.setup();
    renderMemorySettings();

    await user.click(observerField());
    const picker = await screen.findByRole('dialog', { name: 'Choose a model' });
    await user.click(within(picker).getByRole('option', { name: /Claude Haiku 4.5/iu }));
    expect(observerField()).toHaveTextContent('Claude Haiku 4.5');
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

  it('shows a chosen observer by its maker mark and name', () => {
    useAssistantMemoryPreferencesStore.setState((state) => ({
      observationalMemory: { ...state.observationalMemory, modelTarget: 'openai/gpt-5.4-mini' },
    }));
    renderMemorySettings();

    const field = observerField();
    expect(field).toHaveTextContent('GPT-5.4 Mini');
    expect(field.querySelector('[data-model-mark]')).toHaveAttribute('data-model-mark', 'openai');
  });
});
