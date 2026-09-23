/**
 * The composer's "Output & Limits" submenu holds number fields that commit a
 * DRAFT on blur or Enter. Radix dismisses the menu on a pointer-down outside
 * and unmounts the content before the field ever blurs, so the dismissal
 * itself must commit a valid draft and refuse to close over an invalid one —
 * never drop either silently. Real Chromium: jsdom has no pointer-down-outside
 * ordering, no `pointer-events: none` on the body, and no focus fixup.
 */
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ControlsMenu } from '../assistant-controls-menu';

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
 * Opens Controls → Output & Limits and TYPES `draft` into the step field with
 * the pointer resting on it, as a user does. (Where the pointer rests matters:
 * leaving the submenu's trigger moves focus to the root menu, which blurs —
 * and commits — the field before any outside click, hiding the defect.)
 */
async function typeStepDraft(draft: string): Promise<HTMLInputElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Open assistant controls' }));
  const submenu = await screen.findByText('Output & Limits');
  await userEvent.hover(submenu);
  await userEvent.click(submenu);
  const steps = await screen.findByRole('spinbutton', { name: 'Max agent steps' });
  await userEvent.clear(steps);
  await userEvent.click(steps);
  await userEvent.keyboard(draft);
  expect(steps).toHaveValue(Number(draft));
  expect(steps).toHaveFocus();
  return steps as HTMLInputElement;
}

/**
 * While the modal menu is open Radix aria-hides everything outside it and sets
 * `pointer-events: none` on the body, so the outside target is found hidden
 * and clicked with `force` — the pointer still lands outside the menu.
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

      await userEvent.click(screen.getByRole('button', { hidden: true, name }), { force: true });

      await expect
        .poll(() => screen.queryByRole('spinbutton', { name: 'Max agent steps' }))
        .toBeNull();
      expect(onProviderSettingsChange.mock.calls).toEqual([['OpenAI', { agentMaxSteps: 64 }]]);
    }
  );

  test('keeps the menu open over an invalid draft, showing the refusal, until Escape discards it', async () => {
    const onProviderSettingsChange = renderMenu();
    const steps = await typeStepDraft('0');

    await userEvent.click(screen.getByRole('button', { hidden: true, name: 'Outside' }), {
      force: true,
    });

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

  test('moving onto a root menu item commits a valid draft exactly once and closes the submenu', async () => {
    const onProviderSettingsChange = renderMenu();
    await typeStepDraft('64');

    // Hovering a root item focuses it: the field blurs, then the submenu sees
    // focus leave it. Both commit paths run; the draft must land once.
    await userEvent.hover(screen.getByRole('menuitemradio', { name: /Compact/ }));

    await expect
      .poll(() => screen.queryByRole('spinbutton', { name: 'Max agent steps' }))
      .toBeNull();
    expect(onProviderSettingsChange.mock.calls).toEqual([['OpenAI', { agentMaxSteps: 64 }]]);
  });

  test('moving onto a root menu item keeps the submenu open over an invalid draft', async () => {
    const onProviderSettingsChange = renderMenu();
    const steps = await typeStepDraft('0');

    await userEvent.hover(screen.getByRole('menuitemradio', { name: /Compact/ }));

    expect(screen.getByRole('spinbutton', { name: 'Max agent steps' })).toBe(steps);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a whole number of steps from 1 to 1,000.'
    );
    expect(onProviderSettingsChange).not.toHaveBeenCalled();
  });

  test('ArrowLeft moves the caret in a field instead of closing the submenu over its draft', async () => {
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
});
