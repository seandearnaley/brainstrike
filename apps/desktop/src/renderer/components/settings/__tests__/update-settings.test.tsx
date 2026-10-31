// @vitest-environment jsdom
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  AppUpdatePreferences,
  AppUpdateStatus,
} from '../../../../ipc-domains/app-updates.contract';
import { DesktopUpdateSettings } from '../update-settings';

type AppUpdatesBridge = NonNullable<Window['appUpdates']>;

function installBridge(
  initial: AppUpdatePreferences,
  status: AppUpdateStatus = { state: 'up-to-date' }
): {
  readonly checkNow: ReturnType<typeof vi.fn<AppUpdatesBridge['checkNow']>>;
  /** Main pushing a status change, as `appUpdates.onStatusChange` delivers it. */
  readonly push: (status: AppUpdateStatus) => void;
  readonly restartToUpdate: ReturnType<typeof vi.fn<AppUpdatesBridge['restartToUpdate']>>;
  readonly setBetaUpdates: ReturnType<typeof vi.fn<AppUpdatesBridge['setBetaUpdates']>>;
} {
  let stored = initial;
  let current = status;
  const listeners = new Set<(status: AppUpdateStatus) => void>();
  const push = (next: AppUpdateStatus) => {
    current = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  const setBetaUpdates = vi.fn<AppUpdatesBridge['setBetaUpdates']>((betaUpdates) => {
    stored = { betaUpdates };
    return Promise.resolve({ ok: true, value: stored });
  });
  const checkNow = vi.fn<AppUpdatesBridge['checkNow']>(() =>
    Promise.resolve({ ok: true, value: current })
  );
  const restartToUpdate = vi.fn<AppUpdatesBridge['restartToUpdate']>(() =>
    Promise.resolve({ ok: true, value: undefined })
  );
  window.appUpdates = {
    checkNow,
    getPreferences: () => Promise.resolve({ ok: true, value: stored }),
    getStatus: () => Promise.resolve({ ok: true, value: current }),
    onStatusChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    restartToUpdate,
    setBetaUpdates,
  };
  return { checkNow, push, restartToUpdate, setBetaUpdates };
}

function updateStatus(): HTMLElement {
  return screen.getByTestId('updates-status');
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

it('Check now shows the check and then what it found (BST-2356)', async () => {
  const bridge = installBridge({ betaUpdates: false });
  bridge.checkNow.mockImplementationOnce(() => {
    bridge.push({ state: 'checking' });
    return new Promise(() => undefined);
  });
  render(<DesktopUpdateSettings />);

  await waitFor(() => expect(updateStatus()).toHaveTextContent('Brainstrike is up to date.'));
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

  expect(updateStatus()).toHaveTextContent('Checking for updates…');
  expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  act(() => bridge.push({ state: 'downloading', version: '1.1.0' }));
  expect(updateStatus()).toHaveTextContent('Downloading version 1.1.0…');
});

it('a downloaded update offers Restart to update (BST-2356)', async () => {
  const bridge = installBridge({ betaUpdates: false }, { state: 'downloading', version: '1.1.0' });
  render(<DesktopUpdateSettings />);

  await waitFor(() => expect(updateStatus()).toHaveTextContent('Downloading version 1.1.0…'));
  expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull();

  act(() => bridge.push({ state: 'ready', version: '1.1.0' }));
  expect(updateStatus()).toHaveTextContent('Version 1.1.0 is ready to install.');
  fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));

  expect(bridge.restartToUpdate).toHaveBeenCalledOnce();
});

it('a copy that does not update itself says so and offers no check (BST-2356)', async () => {
  installBridge({ betaUpdates: false }, { reason: 'not-installed', state: 'off' });
  render(<DesktopUpdateSettings />);

  await waitFor(() =>
    expect(updateStatus()).toHaveTextContent(
      'This copy was not installed from a release, so it does not update itself.'
    )
  );
  expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
});

it('a status Main pushes while Check now is out wins over its earlier answer (BST-2356)', async () => {
  const bridge = installBridge({ betaUpdates: false });
  const answer = Promise.withResolvers<Awaited<ReturnType<AppUpdatesBridge['checkNow']>>>();
  bridge.checkNow.mockImplementationOnce(() => answer.promise);
  render(<DesktopUpdateSettings />);

  await waitFor(() => expect(updateStatus()).toHaveTextContent('Brainstrike is up to date.'));
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
  // A cached download finishes before the check's own answer arrives.
  act(() => bridge.push({ state: 'ready', version: '1.1.0' }));
  await act(async () => {
    answer.resolve({ ok: true, value: { state: 'downloading', version: '1.1.0' } });
    await answer.promise;
  });

  expect(updateStatus()).toHaveTextContent('Version 1.1.0 is ready to install.');
  expect(screen.getByRole('button', { name: 'Restart to update' })).toBeEnabled();
});
