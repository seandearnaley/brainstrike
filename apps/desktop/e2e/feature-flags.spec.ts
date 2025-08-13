import { expect, test } from '@playwright/test';
import {
  closeElectronApp,
  launchElectronApp,
  resetAppState,
  waitForAppReady,
} from './utils/electron-helpers';

test.describe('Desktop Feature Flags - File Explorer V2', () => {
  test('Default: disabled with no CLI/env/LS', async () => {
    const ctx0 = await launchElectronApp();
    try {
      await waitForAppReady(ctx0.window);
      await resetAppState(ctx0.window);
    } finally {
      await closeElectronApp(ctx0);
    }
    const ctx = await launchElectronApp();
    const { window } = ctx;
    try {
      await waitForAppReady(window);
      await window.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(window.getByTestId('explorer-v2-disabled')).toBeVisible();
    } finally {
      await closeElectronApp(ctx);
    }
  });

  test('CLI ON enables V2', async () => {
    const ctx = await launchElectronApp(['--ff_explorer_v2=1']);
    const { window } = ctx;
    try {
      await waitForAppReady(window);
      await window.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(window.getByTestId('explorer-v2-enabled')).toBeVisible();
    } finally {
      await closeElectronApp(ctx);
    }
  });

  test('CLI OFF overrides localStorage ON', async () => {
    // Seed LS ON via settings toggle
    const ctx = await launchElectronApp();
    const { window } = ctx;
    try {
      await waitForAppReady(window);
      await window.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(window.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await window.getByTestId('ff-explorer-v2-toggle').click();
    } finally {
      await closeElectronApp(ctx);
    }
    const ctx2 = await launchElectronApp(['--ff_explorer_v2=0']);
    try {
      const { window } = ctx2;
      await waitForAppReady(window);
      await window.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(window.getByTestId('explorer-v2-disabled')).toBeVisible();
    } finally {
      await closeElectronApp(ctx2);
    }
  });

  test('Env override enables V2', async () => {
    const ctx = await launchElectronApp([], { BRAINSTRIKE_URL_PARAMS: 'ff_explorer_v2=1' });
    const { window } = ctx;
    try {
      await waitForAppReady(window);
      await window.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(window.getByTestId('explorer-v2-enabled')).toBeVisible();
    } finally {
      await closeElectronApp(ctx);
    }
  });

  test('Settings persistence with reloads', async () => {
    const ctx = await launchElectronApp();
    const { window } = ctx;
    try {
      await waitForAppReady(window);
      await window.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(window.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await window.getByTestId('ff-explorer-v2-toggle').click();
      await window.reload();
      await waitForAppReady(window);
      const lsOn = await window.evaluate(() => localStorage.getItem('FEATURE_FILE_EXPLORER_V2'));
      expect(lsOn).toBe('1');
      await window.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(window.getByTestId('explorer-v2-enabled')).toBeVisible();

      await window.getByRole('button', { name: 'Settings', exact: true }).click();
      await window.getByTestId('ff-explorer-v2-toggle').click();
      await window.reload();
      await waitForAppReady(window);
      const lsOff = await window.evaluate(() => localStorage.getItem('FEATURE_FILE_EXPLORER_V2'));
      expect(lsOff).toBe('0');
      await window.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(window.getByTestId('explorer-v2-disabled')).toBeVisible();
    } finally {
      await closeElectronApp(ctx);
    }
  });
});


