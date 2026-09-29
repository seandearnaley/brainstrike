import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ComposerEffortControl } from '../composer-effort-control';
import { MetadataProviders } from '../openrouter-model-metadata-context';

function setup() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('composer-effort-trigger'));
  return screen.getByTestId('composer-effort-popover');
}

describe('ComposerEffortControl', () => {
  it('renders nothing when the provider has no reasoning controls', () => {
    const { container } = render(
      <ComposerEffortControl
        onProviderSettingsChange={vi.fn()}
        providerSettings={{}}
        selectedModel="unknown::mystery-model"
        selectedProvider="unknown"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers undeclared OpenRouter efforts only after matching model metadata arrives', async () => {
    const onChange = vi.fn();
    const control = (
      <ComposerEffortControl
        onProviderSettingsChange={onChange}
        selectedModel="openrouter::openai/gpt-5.4"
        selectedProvider="openrouter"
      />
    );
    const { rerender } = render(
      <MetadataProviders value={{ state: 'loading' }}>{control}</MetadataProviders>
    );
    expect(screen.queryByTestId('composer-effort-trigger')).not.toBeInTheDocument();
    rerender(
      <MetadataProviders
        value={{
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 400_000,
              id: 'openai/gpt-5.4',
              reasoning: {
                defaultEnabled: true,
                mandatory: false,
                supportedEfforts: ['xhigh', 'high'],
                supportsMaxTokens: false,
              },
              source: 'openrouter-models-api',
              supportedParameters: ['reasoning'],
            },
          },
          state: 'resolved',
        }}
      >
        {control}
      </MetadataProviders>
    );
    await openPopover(setup());
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' });
    fireEvent.change(slider, { target: { value: slider.getAttribute('max') } });
    expect(onChange).toHaveBeenCalledWith(
      'openrouter',
      expect.objectContaining({ reasoningEffort: 'xhigh' })
    );
  });

  it('renders nothing without a selected provider', () => {
    const { container } = render(
      <ComposerEffortControl onProviderSettingsChange={vi.fn()} providerSettings={{}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  describe('always-visible trigger readout', () => {
    it('reads the active effort without opening anything', () => {
      render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ openai: { reasoningEffort: 'high' } }}
          selectedModel="openai::gpt-5.6-terra"
          selectedProvider="openai"
        />
      );
      const trigger = screen.getByTestId('composer-effort-trigger');
      expect(trigger).toHaveTextContent('High');
      // WCAG 2.5.3 Label in Name: the accessible name must CONTAIN the
      // visible "Effort High" (sr-only "Reasoning" prefix is a superset).
      expect(trigger).toHaveAccessibleName('Reasoning Effort High');
    });

    it('reads Auto when no effort is persisted', () => {
      render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{}}
          selectedModel="openai::gpt-5.6-terra"
          selectedProvider="openai"
        />
      );
      expect(screen.getByTestId('composer-effort-trigger')).toHaveTextContent('Auto');
    });

    it('reads Thinking Off for anthropic with no thinking configured', () => {
      render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ anthropic: {} }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );
      const trigger = screen.getByTestId('composer-effort-trigger');
      expect(trigger).toHaveAccessibleName('Thinking Off');
      expect(trigger).toHaveTextContent('Off');
    });

    it('reads the anthropic effort when thinking is on with an effort', () => {
      render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ anthropic: { anthropicEffort: 'high' } }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );
      const trigger = screen.getByTestId('composer-effort-trigger');
      expect(trigger).toHaveAccessibleName('Thinking High');
    });

    it('reads Thinking On (not "Auto") when the anthropic budget is set with no explicit effort', () => {
      render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ anthropic: { anthropicThinkingBudgetTokens: 12_000 } }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );
      // "Thinking Auto" would be ambiguous against "Thinking Off" at a
      // glance — an implicit Auto effort reads as the explicit word "On".
      expect(screen.getByTestId('composer-effort-trigger')).toHaveAccessibleName('Thinking On');
    });

    it('reads Thinking On/Off for the local provider (no effort axis)', () => {
      const { rerender } = render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ local: { localThinkingEnabled: true } }}
          selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
          selectedProvider="local"
        />
      );
      expect(screen.getByTestId('composer-effort-trigger')).toHaveAccessibleName('Thinking On');

      rerender(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ local: { localThinkingEnabled: false } }}
          selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
          selectedProvider="local"
        />
      );
      expect(screen.getByTestId('composer-effort-trigger')).toHaveAccessibleName('Thinking Off');
    });

    it('disables the trigger (readout stays visible) when settings updates are unavailable', () => {
      render(
        <ComposerEffortControl
          providerSettings={{ openai: { reasoningEffort: 'high' } }}
          selectedModel="openai::gpt-5.6-terra"
          selectedProvider="openai"
        />
      );
      const trigger = screen.getByTestId('composer-effort-trigger');
      expect(trigger).toBeDisabled();
      expect(trigger).toHaveTextContent('High');
    });
  });

  describe('effort slider popover', () => {
    it('offers resolver-derived stops and emits the exact settings update', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ openai: {} }}
          selectedModel="openai::gpt-5.6-terra"
          selectedProvider="openai"
        />
      );

      const popover = await openPopover(user);
      const slider = within(popover).getByTestId('composer-effort-slider');
      expect(within(popover).getByTestId('composer-effort-value')).toHaveTextContent('Auto');

      const rowText = within(popover).getByTestId('composer-effort-row').textContent ?? '';
      expect(rowText).toContain('Minimal');
      expect(rowText).toContain('Extra');
      // `max` is only valid where a model declares it, so it must not appear
      // on the default OpenAI-family track.
      expect(rowText).not.toContain('Max');

      // Track is [Auto, Minimal, Low, Medium, High, Extra]; index 4 is High.
      expect(slider).toHaveAttribute('max', '5');
      fireEvent.change(slider, { target: { value: '4' } });
      expect(onProviderSettingsChange).toHaveBeenCalledWith('openai', { reasoningEffort: 'high' });
      // The popover stays open across slider changes (no menu-dismiss friction).
      expect(screen.getByTestId('composer-effort-popover')).toBeInTheDocument();
    });

    it('positions the thumb at the current effort and clears via the Auto stop', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ openai: { reasoningEffort: 'high' } }}
          selectedModel="openai::gpt-5.6-terra"
          selectedProvider="openai"
        />
      );

      const popover = await openPopover(user);
      const slider = within(popover).getByTestId('composer-effort-slider');
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
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ openai: { reasoningEffort: 'none' } }}
          selectedModel="openai::gpt-5.6-terra"
          selectedProvider="openai"
        />
      );

      // The readout must reflect what's actually being sent
      // (reasoningEffort: 'none'), not lie by falling back to "Auto".
      expect(screen.getByTestId('composer-effort-trigger')).toHaveTextContent('None');

      const popover = await openPopover(user);
      const value = within(popover).getByTestId('composer-effort-value');
      expect(value).toHaveTextContent('None');
      expect(value).not.toHaveTextContent('Auto');
      expect(within(popover).getByTestId('composer-effort-slider')).toHaveAttribute(
        'aria-valuetext',
        'None'
      );
    });

    it('marks the vendor default stop for Kimi K3 and keeps the ordinal axis', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{}}
          selectedModel="openrouter::moonshotai/kimi-k3"
          selectedProvider="openrouter"
        />
      );

      const popover = await openPopover(user);
      const row = within(popover).getByTestId('composer-effort-row');
      const slider = within(popover).getByTestId('composer-effort-slider');
      expect(slider).toHaveAttribute('max', '4');

      // A slider is an ORDINAL axis: dragging right must mean "think harder".
      const tickLabels = [...row.querySelectorAll('span[aria-hidden] span')].map(
        (node) => node.textContent
      );
      expect(tickLabels).toEqual(['Auto', 'None', 'Low', 'High', 'Max•']);
      expect(tickLabels.filter((label) => label?.endsWith('•'))).toEqual(['Max•']);

      fireEvent.change(slider, { target: { value: '4' } });
      expect(onProviderSettingsChange).toHaveBeenCalledWith('openrouter', {
        reasoningEffort: 'max',
      });
      fireEvent.change(slider, { target: { value: '1' } });
      expect(onProviderSettingsChange).toHaveBeenCalledWith('openrouter', {
        reasoningEffort: 'none',
      });
    });

    it('announces the vendor recommendation once that effort is in effect', async () => {
      const user = setup();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ openrouter: { reasoningEffort: 'max' } }}
          selectedModel="openrouter::moonshotai/kimi-k3"
          selectedProvider="openrouter"
        />
      );

      const popover = await openPopover(user);
      expect(within(popover).getByTestId('composer-effort-value')).toHaveTextContent(
        'Max (recommended)'
      );
      expect(within(popover).getByTestId('composer-effort-slider')).toHaveAttribute(
        'aria-valuetext',
        'Max (recommended)'
      );
    });
  });

  describe('thinking toggle popover', () => {
    it('sends the section-identical update for anthropic and keeps the popover open', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ anthropic: {} }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );

      const popover = await openPopover(user);
      const row = within(popover).getByTestId('composer-thinking-row');
      expect(within(row).getByText('Thinking')).toBeInTheDocument();

      const toggle = within(row).getByRole('switch', { name: 'Toggle thinking' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      await user.click(toggle);

      // Identical to the old AnthropicReasoningSection switch payload.
      expect(onProviderSettingsChange).toHaveBeenCalledWith('anthropic', {
        anthropicThinkingBudgetTokens: 12_000,
      });
      expect(screen.getByTestId('composer-thinking-row')).toBeInTheDocument();
    });

    it('clears the anthropic budget and effort when toggled off', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ anthropic: { anthropicThinkingBudgetTokens: 4096 } }}
          selectedModel="anthropic::claude-sonnet-5"
          selectedProvider="anthropic"
        />
      );

      const popover = await openPopover(user);
      await user.click(within(popover).getByRole('switch', { name: 'Toggle thinking' }));

      expect(onProviderSettingsChange).toHaveBeenCalledWith('anthropic', {
        anthropicEffort: undefined,
        anthropicThinkingBudgetTokens: undefined,
      });
    });

    it('drives localThinkingEnabled for the local provider without an effort slider', async () => {
      const user = setup();
      const onProviderSettingsChange = vi.fn();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={{ local: { localThinkingEnabled: true } }}
          selectedModel="local::onnx-community/gemma-4-E2B-it-ONNX"
          selectedProvider="local"
        />
      );

      const popover = await openPopover(user);
      expect(within(popover).queryByTestId('composer-effort-row')).not.toBeInTheDocument();
      await user.click(within(popover).getByRole('switch', { name: 'Toggle thinking' }));

      expect(onProviderSettingsChange).toHaveBeenCalledWith('local', {
        localThinkingEnabled: false,
      });
    });

    it('shows no thinking toggle for openai-family providers', async () => {
      const user = setup();
      render(
        <ComposerEffortControl
          onProviderSettingsChange={vi.fn()}
          providerSettings={{}}
          selectedModel="openai::gpt-5.6-terra"
          selectedProvider="openai"
        />
      );

      const popover = await openPopover(user);
      expect(within(popover).queryByTestId('composer-thinking-row')).not.toBeInTheDocument();
    });
  });
});
