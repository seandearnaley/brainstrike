import { act } from '@brainstrike/test-utils/react-act';
import type { ModelPickerModel } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderGroupConfig } from '../assistant-ui-panel';
import { ComposerModelPicker } from '../composer-model-picker';

// cmdk scrolls the active option into view; happy-dom has no layout.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const providerGroups: ProviderGroupConfig[] = [
  {
    providers: [
      {
        capabilities: {
          streaming: true,
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
          streaming: true,
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
            vendor: { id: 'anthropic', name: 'Anthropic' },
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
    providers: [
      {
        capabilities: {
          streaming: true,
        },
        id: 'openrouter',
        models: [
          {
            enabled: true,
            id: 'moonshotai/kimi-k3',
            label: 'Kimi K3 (OpenRouter)',
            supportsStreaming: true,
            type: 'llm',
            vendor: { id: 'moonshot', name: 'Moonshot AI' },
          },
          {
            enabled: true,
            id: 'anthropic/claude-haiku-5.5',
            label: 'Claude Haiku 5.5 (OpenRouter)',
            supportsStreaming: true,
            type: 'llm',
            vendor: { id: 'anthropic', name: 'Anthropic' },
          },
          {
            enabled: true,
            id: 'x-ai/grok-4.7',
            label: 'Grok 4.7 (OpenRouter)',
            supportsStreaming: true,
            type: 'llm',
            vendor: { id: 'xai', name: 'xAI' },
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
    capabilities: { reasoning: 'supported', vision: 'supported' },
    id: 'gpt-5.6-terra',
    providerId: 'openai',
  },
  {
    capabilities: { reasoning: 'supported', vision: 'unsupported' },
    id: 'shared-model-id',
    providerId: 'openai',
  },
  {
    capabilities: { reasoning: 'supported', vision: 'supported' },
    id: 'claude-sonnet-5',
    providerId: 'anthropic',
  },
  {
    capabilities: { reasoning: 'supported', vision: 'unsupported' },
    id: 'shared-model-id',
    providerId: 'anthropic',
  },
  {
    capabilities: { reasoning: 'supported', vision: 'supported' },
    id: 'moonshotai/kimi-k3',
    providerId: 'openrouter',
  },
];

const baseProps = {
  pickerModels,
  providerGroups,
  selectedModel: 'openai::gpt-5.6-terra',
};

const fixtureWithDisabledDeepseek = {
  ...baseProps,
  // Metadata for a DISABLED model, so the Not enabled row's lack of
  // capability icons is a real assertion, not a vacuous one.
  pickerModels: [
    ...pickerModels,
    {
      capabilities: { reasoning: 'supported', vision: 'supported' },
      id: 'deepseek/deepseek-v4.1-flash',
      providerId: 'openrouter',
    },
  ] satisfies ModelPickerModel[],
  providerGroups: providerGroups.map((group) => ({
    ...group,
    providers: group.providers.map((provider) =>
      provider.id === 'openrouter'
        ? {
            ...provider,
            models: [
              ...provider.models,
              {
                enabled: false,
                id: 'deepseek/deepseek-v4.1-flash',
                label: 'DeepSeek V4.1 Flash',
                type: 'llm' as const,
              },
              {
                enabled: false,
                id: 'deepseek/deepseek-v4.1-pro',
                label: 'DeepSeek V4.1 Pro',
                type: 'llm' as const,
              },
            ],
          }
        : provider
    ),
  })),
};

const ENABLE_FLASH = /Enable and select DeepSeek V4\.1 Flash/u;
const ENABLE_PRO = /Enable and select DeepSeek V4\.1 Pro/u;

/**
 * Temporarily owns process-level unhandled rejections so a test can assert an
 * EXPECTED one (a host contract violation must propagate, not be swallowed)
 * without Vitest reporting it as a stray error.
 */
function captureUnhandledRejections(): { reasons: unknown[]; restore: () => void } {
  const previous = process.listeners('unhandledRejection');
  const reasons: unknown[] = [];
  const listener = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', listener);
  return {
    reasons,
    restore: () => {
      process.off('unhandledRejection', listener);
      for (const original of previous) {
        process.on('unhandledRejection', original);
      }
    },
  };
}

function setup() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('composer-model-menu-trigger'));
  return screen.findByRole('dialog');
}

describe('ComposerModelPicker', () => {
  it('renders the selected model on the trigger', () => {
    render(<ComposerModelPicker {...baseProps} onModelChange={vi.fn()} />);

    const trigger = screen.getByTestId('composer-model-menu-trigger');
    expect(trigger).toHaveTextContent('GPT-5.6 Terra');
    expect(trigger).toHaveAccessibleName('Selected model: GPT-5.6 Terra');
    expect(trigger).toBeEnabled();
  });

  it('opens with search focused and shows the selected row with its mark, icons and a Selected mark', async () => {
    const user = setup();
    render(<ComposerModelPicker {...baseProps} onModelChange={vi.fn()} />);

    const picker = await openPicker(user);
    expect(picker).toHaveAccessibleName('Choose a model');
    expect(within(picker).getByRole('combobox')).toHaveFocus();
    const row = within(picker).getAllByRole('option', { name: /GPT-5\.6 Terra/u })[0];
    if (!row) {
      throw new Error('selected row missing');
    }
    expect(within(row).getByRole('img', { name: 'OpenAI' })).toBeInTheDocument();
    expect(within(row).getByLabelText('Vision')).toBeInTheDocument();
    expect(within(row).getByLabelText('Reasoning')).toBeInTheDocument();
    expect(within(row).getByLabelText('Selected')).toBeInTheDocument();
    // One line per model: its name, then only the capability icons' titles.
    expect(row).toHaveTextContent(/^GPT-5\.6 TerraSupports image inputSupports reasoning$/u);
  });

  it('lists valid recents after the selected model, in order, deduped', async () => {
    const user = setup();
    render(
      <ComposerModelPicker
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

    const picker = await openPicker(user);
    const recent = within(picker).getByRole('group', { name: 'Recent' });
    const rows = within(recent).getAllByRole('option');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('GPT-5.6 Terra');
    expect(rows[1]).toHaveTextContent('Claude Sonnet 5');
    expect(rows[2]).toHaveTextContent('Kimi K3 (OpenRouter)');
    expect(within(rows[0] as HTMLElement).getByLabelText('Selected')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByLabelText('Selected')).not.toBeInTheDocument();
  });

  it('emits the composite key when a row is picked', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    render(
      <ComposerModelPicker
        {...baseProps}
        onModelChange={onModelChange}
        recentModels={['anthropic::claude-sonnet-5']}
      />
    );

    const picker = await openPicker(user);
    const recent = within(picker).getByRole('group', { name: 'Recent' });
    await user.click(within(recent).getByRole('option', { name: /Claude Sonnet 5/u }));

    expect(onModelChange).toHaveBeenCalledWith('anthropic::claude-sonnet-5');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps effort and thinking out of the picker (they live in ComposerEffortControl)', async () => {
    const user = setup();
    render(
      <ComposerModelPicker
        {...baseProps}
        onModelChange={vi.fn()}
        selectedModel="anthropic::claude-sonnet-5"
      />
    );

    const picker = await openPicker(user);
    expect(within(picker).queryByTestId('composer-effort-row')).not.toBeInTheDocument();
    expect(within(picker).queryByTestId('composer-thinking-row')).not.toBeInTheDocument();
  });

  it('search flattens to provider-labelled matches and a duplicate bare id resolves through its own provider', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    render(<ComposerModelPicker {...baseProps} onModelChange={onModelChange} />);

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'shared');
    expect(within(picker).queryByRole('group', { name: 'Recent' })).not.toBeInTheDocument();
    // The mark names each row's maker, so duplicate labels stay apart.
    const anthropicRow = within(picker).getByRole('option', { name: /^Anthropic Shared/u });
    expect(within(picker).getByRole('option', { name: /^OpenAI Shared/u })).toBeInTheDocument();
    await user.click(anthropicRow);

    // Duplicate bare id resolves through its own provider — never openai.
    expect(onModelChange).toHaveBeenCalledWith('anthropic::shared-model-id');
    expect(onModelChange).toHaveBeenCalledTimes(1);
  });

  it("marks each row with its maker, and badges the gateway that serves another maker's model", async () => {
    const user = setup();
    render(<ComposerModelPicker {...baseProps} onModelChange={vi.fn()} />);

    const picker = await openPicker(user);
    const gateway = within(picker).getByRole('group', { name: 'OpenRouter' });
    const claude = within(gateway).getByRole('option', { name: /Claude Haiku 5\.5/u });
    const claudeMark = within(claude).getByRole('img', { name: 'Anthropic via OpenRouter' });
    expect(claudeMark).toHaveAttribute('data-model-mark', 'anthropic');
    expect(claudeMark).toHaveAttribute('data-model-route', 'openrouter');
    // A maker without a mark of its own shows its route's, and its name still reads.
    const kimi = within(gateway).getByRole('option', { name: /Kimi K3/u });
    const kimiMark = within(kimi).getByRole('img', { name: 'Moonshot AI via OpenRouter' });
    expect(kimiMark).toHaveAttribute('data-model-mark', 'openrouter');
    // On its maker's own API the mark carries no route badge.
    const hosted = within(picker).getByRole('group', { name: 'Anthropic' });
    const direct = within(hosted).getByRole('option', { name: /^Anthropic Claude Sonnet 5/u });
    const directMark = within(direct).getByRole('img', { name: 'Anthropic' });
    expect(directMark).not.toHaveAttribute('data-model-route');
  });

  it('finds a gateway model by its maker', async () => {
    const user = setup();
    render(<ComposerModelPicker {...baseProps} onModelChange={vi.fn()} />);

    const picker = await openPicker(user);
    // "xai" is in the maker's name only: not in the row's ID, label or route.
    await user.type(within(picker).getByRole('combobox'), 'xai');
    expect(within(picker).getByRole('option', { name: /Grok 4\.7/u })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Kimi K3/u })).not.toBeInTheDocument();
  });

  it('enables then selects a Not enabled match only after the host commits', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    const onEnableModel = vi.fn().mockResolvedValue(true);
    render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={onModelChange}
      />
    );

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    within(picker).getByRole('group', { name: 'Not enabled' });
    await user.click(
      within(picker).getByRole('option', { name: /Enable and select DeepSeek V4\.1 Flash/u })
    );

    expect(onEnableModel).toHaveBeenCalledWith('openrouter', 'deepseek/deepseek-v4.1-flash');
    await waitFor(() =>
      expect(onModelChange).toHaveBeenCalledWith('openrouter::deepseek/deepseek-v4.1-flash')
    );
  });

  it('leaves the selection unchanged when the host reports a failed enable', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    const onEnableModel = vi.fn().mockResolvedValue(false);
    render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={onModelChange}
      />
    );

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    await user.click(
      within(picker).getByRole('option', { name: /Enable and select DeepSeek V4\.1 Flash/u })
    );

    expect(onEnableModel).toHaveBeenCalledWith('openrouter', 'deepseek/deepseek-v4.1-flash');
    // Let the rejected-commit path (false) settle before asserting nothing moved.
    await act(async () => {
      await onEnableModel.mock.results[0]?.value;
    });
    expect(onModelChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      within(picker).getByRole('option', { name: /Enable and select DeepSeek V4\.1 Flash/u })
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('renders Not enabled rows without capability icons', async () => {
    const user = setup();
    render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={vi.fn().mockResolvedValue(true)}
        onModelChange={vi.fn()}
      />
    );

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    const row = within(picker).getByRole('option', { name: ENABLE_FLASH });
    expect(within(row).queryByLabelText('Vision')).not.toBeInTheDocument();
    expect(within(row).queryByLabelText('Reasoning')).not.toBeInTheDocument();
  });

  it('disables every Not-enabled row while an enable is pending, and re-enables them after it settles', async () => {
    const user = setup();
    const pending = Promise.withResolvers<boolean>();
    const onEnableModel = vi.fn(() => pending.promise);
    render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={vi.fn()}
      />
    );

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    await user.click(within(picker).getByRole('option', { name: ENABLE_FLASH }));
    const row = within(picker).getByRole('option', { name: ENABLE_FLASH });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    await user.click(row);
    expect(onEnableModel).toHaveBeenCalledTimes(1);

    // A different Not-enabled row also shows as busy — clicking it while
    // another enable is in flight must be a no-op, not silently ignored
    // with no visible feedback.
    const otherRow = within(picker).getByRole('option', { name: ENABLE_PRO });
    expect(otherRow).toHaveAttribute('aria-disabled', 'true');
    await user.click(otherRow);
    expect(onEnableModel).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(false);
      await pending.promise;
    });

    expect(within(picker).getByRole('option', { name: ENABLE_FLASH })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(within(picker).getByRole('option', { name: ENABLE_PRO })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('clears the pending state when the host enable rejects, and lets the rejection propagate', async () => {
    const rejections = captureUnhandledRejections();
    try {
      const user = setup();
      const onModelChange = vi.fn();
      const boom = new Error('boom');
      const onEnableModel = vi
        .fn<(providerId: string, modelId: string) => Promise<boolean>>()
        .mockRejectedValueOnce(boom)
        .mockResolvedValue(false);
      render(
        <ComposerModelPicker
          {...fixtureWithDisabledDeepseek}
          onEnableModel={onEnableModel}
          onModelChange={onModelChange}
        />
      );

      const picker = await openPicker(user);
      await user.type(within(picker).getByRole('combobox'), 'deepseek');
      await user.click(within(picker).getByRole('option', { name: ENABLE_FLASH }));

      await waitFor(() => expect(rejections.reasons).toEqual([boom]));
      expect(within(picker).getByRole('option', { name: ENABLE_FLASH })).not.toHaveAttribute(
        'aria-disabled',
        'true'
      );

      await user.click(within(picker).getByRole('option', { name: ENABLE_PRO }));
      expect(onEnableModel).toHaveBeenCalledTimes(2);
      expect(onEnableModel).toHaveBeenLastCalledWith('openrouter', 'deepseek/deepseek-v4.1-pro');
      await act(async () => {
        await onEnableModel.mock.results[1]?.value;
      });
      expect(onModelChange).not.toHaveBeenCalled();
    } finally {
      rejections.restore();
    }
  });

  it('a pending enable that commits after a newer pick never overrides it', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    const pending = Promise.withResolvers<boolean>();
    const onEnableModel = vi.fn(() => pending.promise);
    render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={onModelChange}
      />
    );

    const picker = await openPicker(user);
    const search = within(picker).getByRole('combobox');
    await user.type(search, 'deepseek');
    await user.click(within(picker).getByRole('option', { name: ENABLE_FLASH }));
    await user.clear(search);
    await user.click(within(picker).getByRole('option', { name: /Claude Sonnet 5/u }));
    expect(onModelChange).toHaveBeenCalledWith('anthropic::claude-sonnet-5');

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenLastCalledWith('anthropic::claude-sonnet-5');
  });

  it('a pending enable that commits after the picker closed does not select', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    const pending = Promise.withResolvers<boolean>();
    const onEnableModel = vi.fn(() => pending.promise);
    render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={onModelChange}
      />
    );

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    await user.click(within(picker).getByRole('option', { name: ENABLE_FLASH }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(onEnableModel).toHaveBeenCalledTimes(1);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('an external selectedModel change while an enable is pending invalidates it', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    const pending = Promise.withResolvers<boolean>();
    const onEnableModel = vi.fn(() => pending.promise);
    const { rerender } = render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={onModelChange}
      />
    );

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    await user.click(within(picker).getByRole('option', { name: ENABLE_FLASH }));

    // Another control changes selectedModel while the enable is in flight.
    rerender(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={onModelChange}
        selectedModel="anthropic::claude-sonnet-5"
      />
    );

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('unmounting while an enable is pending invalidates it', async () => {
    const user = setup();
    const onModelChange = vi.fn();
    const pending = Promise.withResolvers<boolean>();
    const onEnableModel = vi.fn(() => pending.promise);
    const { unmount } = render(
      <ComposerModelPicker
        {...fixtureWithDisabledDeepseek}
        onEnableModel={onEnableModel}
        onModelChange={onModelChange}
      />
    );

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    await user.click(within(picker).getByRole('option', { name: ENABLE_FLASH }));

    unmount();

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('hides Not enabled rows when no onEnableModel handler is provided', async () => {
    const user = setup();
    render(<ComposerModelPicker {...fixtureWithDisabledDeepseek} onModelChange={vi.fn()} />);

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'deepseek');
    expect(within(picker).queryByRole('option')).not.toBeInTheDocument();
    expect(within(picker).queryByRole('group', { name: 'Not enabled' })).not.toBeInTheDocument();
  });

  it('Escape closes the picker and clears the query', async () => {
    const user = setup();
    render(<ComposerModelPicker {...baseProps} onModelChange={vi.fn()} />);

    const picker = await openPicker(user);
    await user.type(within(picker).getByRole('combobox'), 'gpt');
    expect(within(picker).getByRole('combobox')).toHaveValue('gpt');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('composer-model-menu-trigger')).toHaveFocus();

    const reopened = await openPicker(user);
    expect(within(reopened).getByRole('combobox')).toHaveValue('');
  });

  const noEnabledGroups = () =>
    providerGroups.map((group) => ({
      ...group,
      providers: group.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    }));

  it('opens to an empty state that leads to model settings when no models are enabled', async () => {
    const user = userEvent.setup();
    const onManageModels = vi.fn();
    render(
      <ComposerModelPicker
        onManageModels={onManageModels}
        onModelChange={vi.fn()}
        pickerModels={[]}
        providerGroups={noEnabledGroups()}
      />
    );

    const trigger = screen.getByTestId('composer-model-menu-trigger');
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveTextContent('No models enabled');

    const picker = await openPicker(user);
    expect(picker).toHaveTextContent('No models are enabled');
    await user.click(within(picker).getByRole('button', { name: 'Manage models' }));
    expect(onManageModels).toHaveBeenCalledTimes(1);
    // Settings opens beside the chat, so the picker must not stay open over it.
    await waitFor(() => expect(picker).not.toBeInTheDocument());
  });

  it('offers no settings link in the empty state without one', async () => {
    const user = userEvent.setup();
    render(
      <ComposerModelPicker
        onModelChange={vi.fn()}
        pickerModels={[]}
        providerGroups={noEnabledGroups()}
      />
    );

    const picker = await openPicker(user);
    expect(picker).toHaveTextContent('No models are enabled');
    expect(within(picker).queryByRole('button', { name: 'Manage models' })).toBeNull();
  });

  it('disables the trigger when no onModelChange handler is provided', () => {
    render(<ComposerModelPicker {...baseProps} />);
    expect(screen.getByTestId('composer-model-menu-trigger')).toBeDisabled();
  });
});
