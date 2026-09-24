/**
 * The composer's "Output & Limits" disclosure holds number fields that commit a
 * DRAFT on blur or Enter. Radix dismisses the popover on a pointer-down outside
 * and unmounts the content before the field ever blurs, so the dismissal
 * itself must commit a valid draft and refuse to close over an invalid one —
 * never drop either silently. Real Chromium: jsdom has no pointer-down-outside
 * ordering, no `pointer-events: none` on the body, and no focus fixup.
 */
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';
import {
  type AssistantProviderSettingsMap,
  mergeAssistantProviderSettings,
} from '@brainstrike/types';
import { cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ControlsMenu } from '../assistant-controls-menu';
import { MetadataProviders } from '../openrouter-model-metadata-context';

afterEach(() => {
  cleanup();
});

function renderMenu() {
  const onProviderSettingsChange = vi.fn();
  render(
    <div>
      <button type="button">Outside</button>
      <ControlsMenu
        modelName="gpt-5"
        onProviderSettingsChange={onProviderSettingsChange}
        providerSettings={{ OpenAI: { agentMaxSteps: 8 } }}
        selectedProvider="OpenAI"
      />
    </div>
  );
  return onProviderSettingsChange;
}

/**
 * Opens Controls → Output & Limits and types a draft into the step field.
 */
async function typeStepDraft(draft: string): Promise<HTMLInputElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
  await userEvent.click(await screen.findByText('Output & Limits', { selector: 'summary span' }));
  const steps = await screen.findByRole('spinbutton', { name: 'Max agent steps' });
  await userEvent.clear(steps);
  await userEvent.click(steps);
  await userEvent.keyboard(draft);
  expect(steps).toHaveValue(Number(draft));
  expect(steps).toHaveFocus();
  return steps as HTMLInputElement;
}

/**
 * Both outside and trigger clicks must preserve a valid draft. The popover is
 * non-modal, so the outside target remains normally actionable.
 */
const OUTSIDE_TARGETS = [
  { label: 'an outside click', name: 'Outside' },
  { label: 're-clicking the menu trigger', name: 'Open assistant controls' },
] as const;

describe('ControlsMenu Output & Limits drafts (real browser)', () => {
  test.each(OUTSIDE_TARGETS)(
    'commits a valid step draft when $label dismisses the menu',
    async ({ name }) => {
      const onProviderSettingsChange = renderMenu();
      await typeStepDraft('64');
      expect(onProviderSettingsChange).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name }));

      await expect
        .poll(() => screen.queryByRole('spinbutton', { name: 'Max agent steps' }))
        .toBeNull();
      expect(onProviderSettingsChange.mock.calls).toEqual([['OpenAI', { agentMaxSteps: 64 }]]);
    }
  );

  test('keeps the menu open over an invalid draft, showing the refusal, until Escape discards it', async () => {
    const onProviderSettingsChange = renderMenu();
    const steps = await typeStepDraft('0');

    await userEvent.click(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.getByRole('spinbutton', { name: 'Max agent steps' })).toBe(steps);
    expect(steps).toHaveValue(0);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a whole number of steps from 1 to 1,000.'
    );
    expect(onProviderSettingsChange).not.toHaveBeenCalled();

    await userEvent.click(steps);
    await userEvent.keyboard('{Escape}');
    await expect
      .poll(() => screen.queryByRole('spinbutton', { name: 'Max agent steps' }))
      .toBeNull();
    expect(onProviderSettingsChange).not.toHaveBeenCalled();
  });

  test('collapsing Output & Limits commits a valid draft exactly once', async () => {
    const onProviderSettingsChange = renderMenu();
    await typeStepDraft('64');
    await userEvent.click(screen.getByText('Output & Limits', { selector: 'summary span' }));

    expect(
      screen.getByText('Output & Limits', { selector: 'summary span' }).closest('details')
    ).not.toHaveAttribute('open');
    expect(onProviderSettingsChange.mock.calls).toEqual([['OpenAI', { agentMaxSteps: 64 }]]);
  });

  test('collapsing Output & Limits keeps an invalid draft visible', async () => {
    const onProviderSettingsChange = renderMenu();
    const steps = await typeStepDraft('0');

    await userEvent.click(screen.getByText('Output & Limits', { selector: 'summary span' }));

    expect(screen.getByRole('spinbutton', { name: 'Max agent steps' })).toBe(steps);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a whole number of steps from 1 to 1,000.'
    );
    expect(onProviderSettingsChange).not.toHaveBeenCalled();
  });

  test('switching a refused output draft to Auto lets an outside click dismiss the menu again', async () => {
    const onProviderSettingsChange = vi.fn();
    function StatefulMenu() {
      const [settings, setSettings] = useState<AssistantProviderSettingsMap>({
        OpenAI: { maxOutputTokens: 1024 },
      });
      return (
        <ControlsMenu
          modelName="gpt-5"
          onProviderSettingsChange={(providerId, updates) => {
            onProviderSettingsChange(providerId, updates);
            setSettings((current) => ({
              ...current,
              [providerId]: mergeAssistantProviderSettings(current[providerId], updates),
            }));
          }}
          providerSettings={settings}
          selectedProvider="OpenAI"
        />
      );
    }
    render(
      <div>
        <button type="button">Outside</button>
        <StatefulMenu />
      </div>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
    await userEvent.click(await screen.findByText('Output & Limits', { selector: 'summary span' }));
    const output = await screen.findByRole('spinbutton', { name: 'Output token limit' });
    await userEvent.clear(output);
    await userEvent.keyboard('99999{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Output limit exceeds the 8,192 maximum.');

    await userEvent.click(screen.getByRole('switch', { name: 'Limit output tokens per step' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Outside' }));

    await expect
      .poll(() => screen.queryByRole('spinbutton', { name: 'Output token limit' }))
      .toBeNull();
    expect(onProviderSettingsChange.mock.calls).toEqual([
      ['OpenAI', { maxOutputTokens: undefined }],
    ]);
  });

  test('Escape from another control closes the popover and unblocks the composer a refusal blocked', async () => {
    const onValidation = vi.fn();
    render(
      <MetadataProviders onValidation={onValidation} value={undefined}>
        <ControlsMenu
          modelName="gpt-5"
          onProviderSettingsChange={vi.fn()}
          providerSettings={{ OpenAI: { maxOutputTokens: 1024 } }}
          selectedProvider="OpenAI"
        />
      </MetadataProviders>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
    await userEvent.click(await screen.findByText('Output & Limits', { selector: 'summary span' }));
    const output = await screen.findByRole('spinbutton', { name: 'Output token limit' });
    await userEvent.clear(output);
    await userEvent.keyboard('99999{Enter}');
    expect(onValidation).toHaveBeenLastCalledWith('Output limit exceeds the 8,192 maximum.');

    // Focus leaves the field without toggling anything; Escape closes Controls.
    screen.getByRole('switch', { name: 'Limit output tokens per step' }).focus();
    await userEvent.keyboard('{Escape}');

    await expect
      .poll(() => screen.queryByRole('spinbutton', { name: 'Output token limit' }))
      .toBeNull();
    expect(onValidation).toHaveBeenLastCalledWith(undefined);
  });

  test('ArrowLeft moves the caret in a field without closing the popover', async () => {
    const onProviderSettingsChange = renderMenu();
    const steps = await typeStepDraft('64');

    await userEvent.keyboard('{ArrowLeft}');

    expect(screen.getByRole('spinbutton', { name: 'Max agent steps' })).toBe(steps);
    expect(steps).toHaveFocus();
    expect(steps).toHaveValue(64);
    expect(onProviderSettingsChange).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(onProviderSettingsChange.mock.calls).toEqual([['OpenAI', { agentMaxSteps: 64 }]]);
  });

  test('Tab moves from a numeric field to its switch and commits the draft', async () => {
    const onProviderSettingsChange = renderMenu();
    await typeStepDraft('64');

    await userEvent.keyboard('{Tab}');

    expect(screen.getByRole('switch', { name: 'Limit agent steps' })).toHaveFocus();
    expect(onProviderSettingsChange.mock.calls).toEqual([['OpenAI', { agentMaxSteps: 64 }]]);
    expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();
  });

  test('ArrowLeft adjusts the output slider while Controls stays open', async () => {
    const onProviderSettingsChange = vi.fn();
    render(
      <ControlsMenu
        modelName="gpt-5"
        onProviderSettingsChange={onProviderSettingsChange}
        providerSettings={{ OpenAI: { maxOutputTokens: 1024 } }}
        selectedProvider="OpenAI"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
    await userEvent.click(await screen.findByText('Output & Limits', { selector: 'summary span' }));
    const slider = screen.getByRole('slider', { name: 'Max output tokens' });
    slider.focus();
    await userEvent.keyboard('{ArrowLeft}');

    expect(slider).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();
    expect(onProviderSettingsChange).toHaveBeenCalledWith('OpenAI', {
      maxOutputTokens: expect.any(Number),
    });
  });
});
