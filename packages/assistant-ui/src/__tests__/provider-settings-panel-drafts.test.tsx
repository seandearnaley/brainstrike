/**
 * The composer's "Output & Limits" number fields edit a DRAFT and commit it on
 * blur or Enter; Escape discards it. A keystroke is not a value: typing
 * "80000" must not store the clamped "8" on the way, and clearing a field to
 * retype it must not switch its limit off mid-edit. A committed value outside
 * the range is REFUSED with a message and stores nothing — never clamped.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsPanel } from '../provider-settings-panel';

afterEach(() => {
  cleanup();
});

describe('ProviderSettingsPanel number fields', () => {
  it('stores a typed step limit once, on blur — clearing it to retype never switches it off', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ agentMaxSteps: 8 }}
      />
    );
    const steps = screen.getByRole('spinbutton', { name: 'Max agent steps' });
    await user.clear(steps);
    await user.type(steps, '64');
    expect(steps).toHaveValue(64);
    expect(onSettingsChange).not.toHaveBeenCalled();
    await user.tab();
    expect(onSettingsChange.mock.calls).toEqual([['openai', { agentMaxSteps: 64 }]]);
  });

  it('typing an input token limit never stores the clamped first keystroke', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ agentInputTokenLimit: 32_000 }}
      />
    );
    const limit = screen.getByRole('spinbutton', { name: 'Input token limit' });
    await user.clear(limit);
    await user.type(limit, '80000');
    expect(onSettingsChange).not.toHaveBeenCalled();
    await user.type(limit, '{Enter}');
    expect(onSettingsChange.mock.calls).toEqual([['openai', { agentInputTokenLimit: 80_000 }]]);
  });

  it('refuses an out-of-range committed value with a message instead of clamping it', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ agentInputTokenLimit: 32_000, agentMaxSteps: 8, memoryLastMessages: 40 }}
      />
    );
    const steps = screen.getByRole('spinbutton', { name: 'Max agent steps' });
    await user.clear(steps);
    await user.type(steps, '0');
    await user.tab();
    expect(steps).toHaveValue(0);
    expect(steps).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter a whole number of steps from 1 to/);

    const limit = screen.getByRole('spinbutton', { name: 'Input token limit' });
    await user.clear(limit);
    await user.type(limit, '1');
    await user.tab();
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent(
      'Enter a whole number of input tokens from 4,096 to 256,000.'
    );

    const memory = screen.getByRole('spinbutton', { name: 'Memory messages' });
    await user.clear(memory);
    await user.type(memory, '2.5');
    await user.tab();
    expect(screen.getAllByRole('alert')[2]).toHaveTextContent(
      'Enter a whole number of messages from 0 to 200.'
    );
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('never unsets a limit for unparseable text a number input reports as empty', () => {
    const onSettingsChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ agentMaxSteps: 8 }}
      />
    );
    const steps = screen.getByRole('spinbutton', { name: 'Max agent steps' });
    // A browser reports value '' with validity.badInput for "1.", "-" or "1e";
    // jsdom never sets badInput, so model the browser's report directly.
    Object.defineProperty(steps, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.change(steps, { target: { value: '' } });
    fireEvent.blur(steps);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of steps from 1 to');
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('Escape restores the stored value and the next blur stores nothing', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ memoryLastMessages: 40 }}
      />
    );
    const memory = screen.getByRole('spinbutton', { name: 'Memory messages' });
    await user.clear(memory);
    await user.type(memory, '12{Escape}');
    expect(memory).toHaveValue(40);
    await user.tab();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('a cleared memory field commits the default (unset), as before', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ memoryLastMessages: 12 }}
      />
    );
    const memory = screen.getByRole('spinbutton', { name: 'Memory messages' });
    await user.clear(memory);
    await user.tab();
    expect(onSettingsChange.mock.calls).toEqual([['openai', { memoryLastMessages: undefined }]]);
  });

  it('switching a limit off discards its refused draft', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const { rerender } = render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{ agentMaxSteps: 8 }}
      />
    );
    const steps = screen.getByRole('spinbutton', { name: 'Max agent steps' });
    await user.clear(steps);
    await user.type(steps, '0');
    await user.click(screen.getByRole('switch', { name: 'Limit agent steps' }));
    expect(onSettingsChange.mock.calls).toEqual([['openai', { agentMaxSteps: undefined }]]);
    rerender(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="openai"
        settings={{}}
      />
    );
    expect(screen.getByRole('spinbutton', { name: 'Max agent steps' })).toHaveValue(null);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('typing an output limit never lands a partial value, and validation reports at commit', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const onValidationChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        onValidationChange={onValidationChange}
        providerId="openai"
        settings={{ maxOutputTokens: 1024 }}
      />
    );
    const output = screen.getByRole('spinbutton', { name: 'Output token limit' });
    await user.clear(output);
    await user.type(output, '4096');
    // "409" is a valid limit: per-keystroke commits used to store it.
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onValidationChange).not.toHaveBeenCalled();
    await user.tab();
    expect(onSettingsChange.mock.calls).toEqual([['openai', { maxOutputTokens: 4096 }]]);
    expect(onValidationChange).toHaveBeenLastCalledWith(undefined);
  });

  it('an invalid output draft blocks the composer until Escape restores the stored value', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const onValidationChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        onValidationChange={onValidationChange}
        providerId="openai"
        settings={{ maxOutputTokens: 1024 }}
      />
    );
    const output = screen.getByRole('spinbutton', { name: 'Output token limit' });
    await user.clear(output);
    await user.type(output, '99999{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent(/8,192 maximum/);
    expect(onValidationChange).toHaveBeenLastCalledWith(expect.stringContaining('8,192 maximum'));
    await user.type(output, '{Escape}');
    expect(output).toHaveValue(1024);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onValidationChange).toHaveBeenLastCalledWith(undefined);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('commits a typed thinking budget on blur, not per keystroke', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <ProviderSettingsPanel
        onSettingsChange={onSettingsChange}
        providerId="anthropic"
        settings={{ anthropicThinkingBudgetTokens: 4096 }}
      />
    );
    const budget = screen.getByRole('spinbutton', { name: 'Anthropic thinking budget input' });
    await user.clear(budget);
    await user.type(budget, '12000');
    expect(onSettingsChange).not.toHaveBeenCalled();
    await user.tab();
    expect(onSettingsChange.mock.calls).toEqual([
      ['anthropic', { anthropicThinkingBudgetTokens: 12_000 }],
    ]);
  });
});
