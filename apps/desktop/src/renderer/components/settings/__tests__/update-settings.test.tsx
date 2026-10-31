// @vitest-environment jsdom
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppUpdatePreferences } from '../../../../ipc-domains/app-updates.contract';
import { DesktopUpdateSettings } from '../update-settings';

type AppUpdatesBridge = NonNullable<Window['appUpdates']>;

function installBridge(initial: AppUpdatePreferences): {
  readonly setBetaUpdates: ReturnType<typeof vi.fn<AppUpdatesBridge['setBetaUpdates']>>;
} {
  let stored = initial;
  const setBetaUpdates = vi.fn<AppUpdatesBridge['setBetaUpdates']>((betaUpdates) => {
    stored = { betaUpdates };
    return Promise.resolve({ ok: true, value: stored });
  });
  window.appUpdates = {
    getPreferences: () => Promise.resolve({ ok: true, value: stored }),
    setBetaUpdates,
  };
  return { setBetaUpdates };
}

function betaSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Get beta updates' });
}

afterEach(() => {
  Reflect.deleteProperty(window, 'appUpdates');
});

it('shows the stored choice and saves a change', async () => {
  const bridge = installBridge({ betaUpdates: false });
  render(<DesktopUpdateSettings />);

  await waitFor(() => expect(betaSwitch()).toBeEnabled());
  expect(betaSwitch()).toHaveAttribute('aria-checked', 'false');

  fireEvent.click(betaSwitch());

  await waitFor(() => expect(betaSwitch()).toBeEnabled());
  expect(betaSwitch()).toHaveAttribute('aria-checked', 'true');
  expect(bridge.setBetaUpdates).toHaveBeenCalledExactlyOnceWith(true);
});

it('a failed save puts the switch back and says why', async () => {
  const bridge = installBridge({ betaUpdates: true });
  bridge.setBetaUpdates.mockResolvedValueOnce({ error: INTERNAL_FAULT, ok: false });
  render(<DesktopUpdateSettings />);

  await waitFor(() => expect(betaSwitch()).toBeEnabled());
  fireEvent.click(betaSwitch());

  expect(await screen.findByRole('alert')).toBeVisible();
  expect(betaSwitch()).toHaveAttribute('aria-checked', 'true');
  expect(betaSwitch()).toBeEnabled();
});

it('a window without the updates bridge says so instead of showing a dead switch', () => {
  render(<DesktopUpdateSettings />);

  expect(screen.getByRole('alert')).toHaveTextContent('Updates are unavailable in this window.');
  expect(betaSwitch()).toBeDisabled();
});
