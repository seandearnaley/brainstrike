// @vitest-environment jsdom
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { AppLifetimeSettings } from '../../../../ipc-domains/app-lifetime.contract';
import { DesktopAppLifetimeSettings } from '../app-lifetime-settings';

function installBridge(initial: AppLifetimeSettings, options: { failWrites?: boolean } = {}) {
  let stored = initial;
  window.appLifetime = {
    getSettings: () => Promise.resolve({ ok: true, value: stored }),
    setKeepRunningInTray: (enabled) => {
      if (options.failWrites) {
        return Promise.resolve({ error: INTERNAL_FAULT, ok: false });
      }
      stored = {
        ...stored,
        keepRunningInTray: { available: true, enabled },
        lastWindowClose: enabled ? 'keeps-running' : 'quits',
      };
      return Promise.resolve({ ok: true, value: stored });
    },
    setOpenAtLogin: (enabled) => {
      stored = { ...stored, openAtLogin: { available: true, enabled } };
      return Promise.resolve({ ok: true, value: stored });
    },
  };
}

const trayOn: AppLifetimeSettings = {
  keepRunningInTray: { available: true, enabled: true },
  lastWindowClose: 'keeps-running',
  openAtLogin: { available: true, enabled: false },
};

const traySwitch = () =>
  screen.getByRole('switch', { name: 'Keep running in the tray when closed' });
const loginSwitch = () => screen.getByRole('switch', { name: 'Open at login' });

afterEach(() => {
  Reflect.deleteProperty(window, 'appLifetime');
});

it('shows Main’s settings and saves each switch', async () => {
  installBridge(trayOn);
  render(<DesktopAppLifetimeSettings />);

  await waitFor(() => expect(traySwitch()).toBeEnabled());
  expect(traySwitch()).toHaveAttribute('aria-checked', 'true');
  expect(loginSwitch()).toHaveAttribute('aria-checked', 'false');

  fireEvent.click(traySwitch());
  await waitFor(() => expect(traySwitch()).toHaveAttribute('aria-checked', 'false'));
  fireEvent.click(loginSwitch());
  await waitFor(() => expect(loginSwitch()).toHaveAttribute('aria-checked', 'true'));
});

it('says why a switch is unavailable instead of offering it', async () => {
  installBridge({
    keepRunningInTray: {
      available: false,
      reason: 'Your desktop shows no tray icons, so closing the last window quits Brainstrike.',
    },
    lastWindowClose: 'quits',
    openAtLogin: { available: false, reason: "Open at login isn't available on Linux yet." },
  });
  render(<DesktopAppLifetimeSettings />);

  await screen.findByText(/shows no tray icons/u);
  expect(screen.getByText("Open at login isn't available on Linux yet.")).toBeVisible();
  expect(traySwitch()).toBeDisabled();
  expect(loginSwitch()).toBeDisabled();
});

it('has no tray choice where the Dock keeps the app running', async () => {
  installBridge({ ...trayOn, keepRunningInTray: null });
  render(<DesktopAppLifetimeSettings />);

  await waitFor(() => expect(loginSwitch()).toBeEnabled());
  expect(screen.queryByRole('switch', { name: /tray/u })).toBeNull();
});

it('keeps the saved choice and shows the failure when Main refuses a write', async () => {
  installBridge(trayOn, { failWrites: true });
  render(<DesktopAppLifetimeSettings />);
  await waitFor(() => expect(traySwitch()).toBeEnabled());

  fireEvent.click(traySwitch());

  expect(await screen.findByRole('alert')).toBeVisible();
  expect(traySwitch()).toHaveAttribute('aria-checked', 'true');
});
