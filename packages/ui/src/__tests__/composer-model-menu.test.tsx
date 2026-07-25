import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderGroupConfig } from '../assistant-ui-panel/assistant-ui-panel';
import { ComposerModelMenu } from '../assistant-ui-panel/composer-model-menu';
import type { ModelPickerModel } from '../model-picker';

const providerGroups: ProviderGroupConfig[] = [
  {
    label: 'Hosted',
    providers: [
      {
        capabilities: {
          embeddings: true,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: true,
        },
        id: 'openai',
        models: [
          {
            default: true,
            enabled: true,
            id: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            supportsStreaming: true,
            type: 'llm',
          },
          {
            enabled: true,
            // Duplicate BARE id also exists under anthropic below — the menu
            // must emit provider-qualified composite keys (regression for the
            // old modelToProviderMap mis-resolution).
            id: 'shared-model-id',
            label: 'Shared (OpenAI)',
            supportsStreaming: true,
            type: 'llm',
          },
        ],
        name: 'OpenAI',
        runtime: 'hosted',
      },
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'anthropic',
        models: [
          {
            default: true,
            enabled: true,
            id: 'claude-sonnet-5',
            label: 'Claude Sonnet 5',
            supportsStreaming: true,
            type: 'llm',
          },
          {
            enabled: true,
            id: 'shared-model-id',
            label: 'Shared (Anthropic)',
            supportsStreaming: true,
            type: 'llm',
          },
        ],
        name: 'Anthropic',
        runtime: 'hosted',
      },
    ],
    runtime: 'hosted',
  },
  {
    label: 'Gateway',
    providers: [
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'openrouter',
        models: [
          {
            enabled: true,
            id: 'moonshotai/kimi-k3',
            label: 'Kimi K3 (OpenRouter)',
            supportsStreaming: true,
            type: 'llm',
          },
        ],
        name: 'OpenRouter',
        runtime: 'gateway',
      },
    ],
    runtime: 'gateway',
  },
];

const pickerModels: ModelPickerModel[] = [
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'supported' },
    contextWindow: 1_050_000,
    description: 'Most capable for everyday work',
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    providerId: 'openai',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'unsupported' },
    contextWindow: 400_000,
    description: null,
    id: 'shared-model-id',
    name: 'Shared (OpenAI)',
    providerId: 'openai',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'supported' },
    contextWindow: 1_000_000,
    description: 'Best mix of smarts and speed',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    providerId: 'anthropic',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'unsupported' },
    contextWindow: 400_000,
    description: null,
    id: 'shared-model-id',
    name: 'Shared (Anthropic)',
    providerId: 'anthropic',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'supported' },
    contextWindow: 1_048_576,
    description: null,
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3 (OpenRouter)',
    providerId: 'openrouter',
  },
];

const baseProps = {
  pickerModels,
  providerGroups,
  selectedModel: 'openai::gpt-5.6-terra',
  selectedProvider: 'openai',
};

function setup() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('composer-model-menu-trigger'));
  return screen.getByRole('menu');
}

describe('ComposerModelMenu', () => {
  it('renders the selected model on the trigger', () => {
    render(<ComposerModelMenu {...baseProps} onModelChange={vi.fn()} />);

    const trigger = screen.getByTestId('composer-model-menu-trigger');
    expect(trigger).toHaveTextContent('GPT-5.6 Terra');
    expect(trigger).toHaveAccessibleName('Selected model: GPT-5.6 Terra');
    expect(trigger).toBeEnabled();
  });

  it('shows the selected row with tagline, capability icons, and checkmark', async () => {
    const user = setup();
    render(<ComposerModelMenu {...baseProps} onModelChange={vi.fn()} />);

    const menu = await openMenu(user);
    const selectedRow = within(menu).getByRole('menuitemradio', { name: /GPT-5\.6 Terra/ });
    expect(selectedRow).toHaveAttribute('aria-checked', 'true');
    expect(within(selectedRow).getByText('Most capable for everyday work')).toBeInTheDocument();
    expect(within(selectedRow).getByLabelText('Vision')).toBeInTheDocument();
    expect(within(selectedRow).getByLabelText('Reasoning')).toBeInTheDocument();
  });

  it('lists valid recents after the selected model, in order, deduped', async () => {
    const user = setup();
    render(
      <ComposerModelMenu
        {...baseProps}
        onModelChange={vi.fn()}
        recentModels={[
          'openai::gpt-5.6-terra', // duplicate of selection — deduped
          'anthropic::claude-sonnet-5',
          'google::not-a-valid-option', // filtered out
          'openrouter::moonshotai/kimi-k3',
        ]}
      />
    );

    const menu = await openMenu(user);
    const rows = within(menu).getAllByRole('menuitemradio');
    expect(rows[0]).toHaveTextContent('GPT-5.6 Terra');
    expect(rows[1]).toHaveTextContent('Claude Sonnet 5');
    expect(rows[2]).toHaveTextContent('Kimi K3 (OpenRouter)');
    expect(rows[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('emits the composite key when a top-level row is picked', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    render(
      <ComposerModelMenu
        {...baseProps}
        onModelChange={onModelChange}
        recentModels={['anthropic::claude-sonnet-5']}
      />
    );

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: /Claude Sonnet 5/ }));

    expect(onModelChange).toHaveBeenCalledWith('anthropic::claude-sonnet-5');
  });

  describe('Effort slider', () => {
    it('offers resolver-derived stops inline and emits the exact settings update', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ openai: {} }}
        />
      );

      const menu = await openMenu(user);
      // No submenu to open: effort is one gesture from the model menu.
      const slider = within(menu).getByTestId('composer-effort-slider');
      expect(within(menu).getByTestId('composer-effort-value')).toHaveTextContent('Auto');

      const rowText = within(menu).getByTestId('composer-effort-row').textContent ?? '';
      expect(rowText).toContain('Minimal');
      expect(rowText).toContain('Extra');
      // `max` is only valid where a model declares it, so it must not appear
      // on the default OpenAI-family track.
      expect(rowText).not.toContain('Max');

      // Track is [Auto, Minimal, Low, Medium, High, Extra]; index 4 is High.
      expect(slider).toHaveAttribute('max', '5');
      fireEvent.change(slider, { target: { value: '4' } });
      expect(onProviderSettingsChange).toHaveBeenCalledWith('openai', { reasoningEffort: 'high' });
    });

    it('positions the thumb at the current effort and clears via the Auto stop', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ openai: { reasoningEffort: 'high' } }}
        />
      );

      const menu = await openMenu(user);
      const slider = within(menu).getByTestId('composer-effort-slider');
      expect(slider).toHaveValue('4');
      expect(slider).toHaveAttribute('aria-valuetext', 'High');

      fireEvent.change(slider, { target: { value: '0' } });
      expect(onProviderSettingsChange).toHaveBeenCalledWith('openai', {
        reasoningEffort: undefined,
      });
    });

    it('surfaces a persisted "none" effort instead of silently showing Auto', async () => {
      const user = setup();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ openai: { reasoningEffort: 'none' } }}
        />
      );

      const menu = await openMenu(user);
      // The readout must reflect what's actually being sent
      // (reasoningEffort: 'none'), not lie by falling back to "Auto".
      const value = within(menu).getByTestId('composer-effort-value');
      expect(value).toHaveTextContent('None');
      expect(value).not.toHaveTextContent('Auto');
      expect(within(menu).getByTestId('composer-effort-slider')).toHaveAttribute(
        'aria-valuetext',
        'None'
      );
    });

    it('marks the vendor default stop for Kimi K3 and announces it to assistive tech', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{}}
          selectedModel="openrouter::moonshotai/kimi-k3"
          selectedProvider="openrouter"
        />
      );

      const menu = await openMenu(user);
      const row = within(menu).getByTestId('composer-effort-row');
      const slider = within(menu).getByTestId('composer-effort-slider');
      expect(slider).toHaveAttribute('max', '4');

      // A slider is an ORDINAL axis: dragging right must mean "think harder".
      // OpenRouter's live metadata lists efforts strongest-first, which as a
      // radio list was harmless but as a track silently inverted the control.
      const tickLabels = [...row.querySelectorAll('span[aria-hidden] span')].map(
        (node) => node.textContent
      );
      expect(tickLabels).toEqual(['Auto', 'None', 'Low', 'High', 'Max•']);

      // Exactly one stop carries the vendor-default marker, and it is Max.
      expect(tickLabels.filter((label) => label?.endsWith('•'))).toEqual(['Max•']);

      // The strongest stop is the LAST position and writes the effort verbatim.
      fireEvent.change(slider, { target: { value: '4' } });
      expect(onProviderSettingsChange).toHaveBeenCalledWith('openrouter', {
        reasoningEffort: 'max',
      });
      // ...and the weakest real effort sits at position 1, just after Auto.
      fireEvent.change(slider, { target: { value: '1' } });
      expect(onProviderSettingsChange).toHaveBeenCalledWith('openrouter', {
        reasoningEffort: 'none',
      });
    });

    it('announces the vendor recommendation once that effort is in effect', async () => {
      const user = setup();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ openrouter: { reasoningEffort: 'max' } }}
          selectedModel="openrouter::moonshotai/kimi-k3"
          selectedProvider="openrouter"
        />
      );

      const menu = await openMenu(user);
      expect(within(menu).getByTestId('composer-effort-value')).toHaveTextContent(
        'Max (recommended)'
      );
      expect(within(menu).getByTestId('composer-effort-slider')).toHaveAttribute(
        'aria-valuetext',
        'Max (recommended)'
      );
    });

    it('disables the Effort row when settings updates are unavailable', async () => {
      const user = setup();
      render(<ComposerModelMenu {...baseProps} onModelChange={vi.fn()} />);

      const menu = await openMenu(user);
      expect(within(menu).getByTestId('composer-effort-row')).toHaveAttribute('data-disabled');
      expect(within(menu).getByTestId('composer-effort-slider')).toBeDisabled();
    });
  });

  describe('Thinking toggle', () => {
    it('shows the toggle with subtitle for anthropic and sends the section-identical update, keeping the menu open', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ anthropic: {} }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );

      const menu = await openMenu(user);
      const row = within(menu).getByTestId('composer-thinking-row');
      expect(within(row).getByText('Thinking')).toBeInTheDocument();
      expect(within(row).getByText('Can think for more complex tasks')).toBeInTheDocument();

      const toggle = within(row).getByRole('switch', { name: 'Toggle thinking' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      await user.click(toggle);

      // Identical to the old AnthropicReasoningSection switch payload.
      expect(onProviderSettingsChange).toHaveBeenCalledWith('anthropic', {
        anthropicThinkingBudgetTokens: 12_000,
      });
      // Toggling must not dismiss the menu.
      expect(screen.getByTestId('composer-thinking-row')).toBeInTheDocument();
    });

    it('clears the anthropic budget when toggled off', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ anthropic: { anthropicThinkingBudgetTokens: 4096 } }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );

      const menu = await openMenu(user);
      await user.click(within(menu).getByRole('switch', { name: 'Toggle thinking' }));

      expect(onProviderSettingsChange).toHaveBeenCalledWith('anthropic', {
        anthropicEffort: undefined,
        anthropicThinkingBudgetTokens: undefined,
      });
    });

    it('reads as on when only an anthropic effort is set, and clears it when toggled off', async () => {
      // An effort alone now implies adaptive thinking, so the toggle must both
      // reflect that and be able to switch it off — otherwise the runtime keeps
      // requesting thinking while the switch reads unchecked.
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ anthropic: { anthropicEffort: 'high' } }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );

      const menu = await openMenu(user);
      const toggle = within(menu).getByRole('switch', { name: 'Toggle thinking' });
      expect(toggle).toHaveAttribute('aria-checked', 'true');

      await user.click(toggle);
      expect(onProviderSettingsChange).toHaveBeenCalledWith('anthropic', {
        anthropicEffort: undefined,
        anthropicThinkingBudgetTokens: undefined,
      });
    });

    it('drives localThinkingEnabled for the local provider', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerModelMenu
          onModelChange={vi.fn()}
          onProviderSettingsChange={onProviderSettingsChange}
          pickerModels={[
            {
              capabilities: {
                reasoning: 'supported',
                streaming: false,
                type: 'llm',
                vision: 'unsupported',
              },
              contextWindow: 8192,
              description: 'Runs privately on this device',
              id: 'onnx-community/gemma-4-E2B-it-ONNX',
              name: 'Gemma 4 E2B',
              providerId: 'local',
            },
          ]}
          providerGroups={[
            {
              label: 'Browser',
              providers: [
                {
                  capabilities: {
                    embeddings: false,
                    llm: true,
                    streaming: false,
                    supportsStandardEmbeddingDimension: false,
                  },
                  id: 'local',
                  models: [
                    {
                      default: true,
                      enabled: true,
                      id: 'onnx-community/gemma-4-E2B-it-ONNX',
                      label: 'Gemma 4 E2B',
                      type: 'llm',
                    },
                  ],
                  name: 'Local (Browser)',
                  runtime: 'browser',
                },
              ],
              runtime: 'browser',
            },
          ]}
          providerSettings={{ local: { localThinkingEnabled: true } }}
          selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
          selectedProvider="local"
        />
      );

      const menu = await openMenu(user);
      // Local has a Thinking toggle but NO Effort submenu.
      expect(within(menu).queryByTestId('composer-effort-trigger')).not.toBeInTheDocument();
      await user.click(within(menu).getByRole('switch', { name: 'Toggle thinking' }));

      expect(onProviderSettingsChange).toHaveBeenCalledWith('local', {
        localThinkingEnabled: false,
      });
    });

    it('hides the Thinking toggle for openai-family providers', async () => {
      const user = setup();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          onProviderSettingsChange={vi.fn()}
        />
      );

      const menu = await openMenu(user);
      expect(within(menu).queryByTestId('composer-thinking-row')).not.toBeInTheDocument();
    });
  });

  describe('More models', () => {
    it('drills down through runtime tiers and provider submenus via keyboard, emitting composite keys', async () => {
      const user = setup();
      const onModelChange = vi.fn();
      render(<ComposerModelMenu {...baseProps} onModelChange={onModelChange} />);

      const menu = await openMenu(user);
      const moreModels = within(menu).getByTestId('composer-more-models-trigger');

      // ArrowRight #1: open the More models tier submenu.
      moreModels.focus();
      await user.keyboard('{ArrowRight}');
      expect(await screen.findByText('Hosted')).toBeInTheDocument();
      expect(screen.getByText('Gateway')).toBeInTheDocument();

      // ArrowRight #2: open the provider sub-submenu.
      const anthropicTrigger = screen.getByRole('menuitem', { name: /Anthropic/ });
      anthropicTrigger.focus();
      await user.keyboard('{ArrowRight}');

      const anthropicShared = await screen.findByRole('menuitemradio', {
        name: /Shared \(Anthropic\)/,
      });
      await user.click(anthropicShared);

      // Duplicate bare id resolves through its own provider — never openai.
      expect(onModelChange).toHaveBeenCalledWith('anthropic::shared-model-id');
    });

    it('shows dense rows with context-window badges', async () => {
      const user = setup();
      render(<ComposerModelMenu {...baseProps} onModelChange={vi.fn()} />);

      const menu = await openMenu(user);
      const moreModels = within(menu).getByTestId('composer-more-models-trigger');
      moreModels.focus();
      await user.keyboard('{ArrowRight}');
      const openaiTrigger = await screen.findByRole('menuitem', { name: /OpenAI/ });
      openaiTrigger.focus();
      await user.keyboard('{ArrowRight}');

      // The top-level row also matches by name, so anchor on the dense row's
      // context-window badge.
      const badge = await screen.findByText('1.1M context');
      expect(badge.closest('[role="menuitemradio"]')).toHaveTextContent('GPT-5.6 Terra');
    });
  });

  it('disables the trigger with a placeholder when no models are enabled', () => {
    render(
      <ComposerModelMenu
        onModelChange={vi.fn()}
        pickerModels={[]}
        providerGroups={providerGroups.map((group) => ({
          ...group,
          providers: group.providers.map((provider) => ({
            ...provider,
            models: provider.models.map((model) => ({ ...model, enabled: false })),
          })),
        }))}
      />
    );

    const trigger = screen.getByTestId('composer-model-menu-trigger');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent('No models enabled');
  });

  it('disables the trigger when no onModelChange handler is provided', () => {
    render(<ComposerModelMenu {...baseProps} />);
    expect(screen.getByTestId('composer-model-menu-trigger')).toBeDisabled();
  });
});
