// @vitest-environment jsdom
import { resetToastStore, Toaster } from '@brainstrike/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppUpdateStatus } from '../../ipc-domains/app-updates.contract';
import { useAppUpdateReadyToast } from '../use-app-update-ready-toast';

/** BST-2356: a window that sees an update finish downloading offers Restart to update. */
type AppUpdatesBridge = NonNullable<Window['appUpdates']>;

function installBridge() {
  const listeners = new Set<(status: AppUpdateStatus) => void>();
  const restartToUpdate = vi.fn<AppUpdatesBridge['restartToUpdate']>(() =>
    Promise.resolve({ ok: true, value: undefined })
  );
  window.appUpdates = {
    checkNow: () => Promise.resolve({ ok: true, value: { state: 'idle' } }),
    getPreferences: () => Promise.resolve({ ok: true, value: { betaUpdates: false } }),
    getStatus: () => Promise.resolve({ ok: true, value: { state: 'idle' } }),
    onStatusChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    restartToUpdate,
    setBetaUpdates: () => Promise.resolve({ ok: true, value: { betaUpdates: false } }),
  };
  const push = (status: AppUpdateStatus) => {
    act(() => {
      for (const listener of listeners) {
        listener(status);
      }
    });
  };
  return { push, restartToUpdate };
}

function Window() {
  useAppUpdateReadyToast();
  return <Toaster />;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'appUpdates');
  resetToastStore();
});

it('offers Restart to update once the download finishes, and restarts when clicked', () => {
  const bridge = installBridge();
  render(<Window />);

  bridge.push({ state: 'downloading', version: '1.1.0' });
  expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull();

  bridge.push({ state: 'ready', version: '1.1.0' });
  expect(screen.getByText('Brainstrike 1.1.0 is ready to install')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));

  expect(bridge.restartToUpdate).toHaveBeenCalledOnce();
});

it('offers each downloaded version once', () => {
  const bridge = installBridge();
  render(<Window />);

  bridge.push({ state: 'ready', version: '1.1.0' });
  bridge.push({ state: 'ready', version: '1.1.0' });

  expect(screen.getAllByText('Brainstrike 1.1.0 is ready to install')).toHaveLength(1);
});
