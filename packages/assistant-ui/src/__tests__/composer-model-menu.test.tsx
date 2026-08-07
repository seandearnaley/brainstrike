import type { ModelPickerModel } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderGroupConfig } from '../assistant-ui-panel';
import { ComposerModelMenu } from '../composer-model-menu';

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

  describe('reasoning controls', () => {
    it('keeps effort and thinking OUT of the menu (they live in ComposerEffortControl)', async () => {
      const user = setup();
      render(
        <ComposerModelMenu
          {...baseProps}
          onModelChange={vi.fn()}
          selectedModel="anthropic::claude-sonnet-5"
        />
      );

      const menu = await openMenu(user);
      expect(within(menu).queryByTestId('composer-effort-row')).not.toBeInTheDocument();
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
