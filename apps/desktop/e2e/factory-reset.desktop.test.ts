import fs from 'node:fs';
import path from 'node:path';
import { updateSettingsTestOverrides } from '../../e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

type ConfirmOverrideTarget = typeof globalThis & {
  confirm: () => boolean;
  __brainstrikeOriginalConfirm__?: () => boolean;
};

async function openTokenCountingSettings(
  homePage: HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Token Counting/i, 'token-counting');
}

async function overrideNextConfirm(
  window: import('@playwright/test').Page,
  value: boolean
): Promise<void> {
  await window.evaluate((nextValue: boolean) => {
    const target = globalThis as unknown as ConfirmOverrideTarget;
    const originalConfirm = target.__brainstrikeOriginalConfirm__ ?? target.confirm;
    target.__brainstrikeOriginalConfirm__ = originalConfirm;
    // Desktop still exercises the native window.confirm reset flow here. If the
    // product switches to a custom dialog, this helper should change with it.
    target.confirm = () => {
      target.confirm = originalConfirm;
      target.__brainstrikeOriginalConfirm__ = undefined;
      return nextValue;
    };
  }, value);
}

async function restoreConfirmOverride(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(() => {
    const target = globalThis as unknown as ConfirmOverrideTarget;
    if (!target.__brainstrikeOriginalConfirm__) {
      return;
    }
    target.confirm = target.__brainstrikeOriginalConfirm__;
    target.__brainstrikeOriginalConfirm__ = undefined;
  });
}

test.describe('Factory Reset settings (desktop) @destructive', () => {
  async function openFactoryResetSettings(
    homePage: HomePage,
    settingsPage: SettingsPage
  ): Promise<void> {
    await homePage.openSettings();
    await settingsPage.openCategory(/Factory Reset/i, 'factory-reset');
  }

  test.afterEach(async ({ window }) => {
    await restoreConfirmOverride(window).catch(() => {
      // Some tests intentionally restart the app, which can invalidate the original page.
    });
  });

  test('cancel path leaves persisted state untouched', async ({ window, homePage }) => {
    await updateSettingsTestOverrides(window, { accurateRuntimeAvailable: true });

    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    const tokenToggle = window.getByTestId('token-counting-accurate-toggle');
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');

    await openFactoryResetSettings(homePage, settingsPage);
    await expect(window.getByRole('switch', { name: 'Enable inline fixtures' })).toBeVisible();
    await expect(window.getByTestId('clear-stored-folders-button')).toHaveCount(0);

    await overrideNextConfirm(window, false);
    await window.getByTestId('factory-reset-button').click();
    await expect(window.getByTestId('settings-category-factory-reset')).toBeVisible();

    const { reloadRenderer, waitForAppReady } = await loadElectronHelpers();
    await reloadRenderer(window, 'desktop-factory-reset-cancel');
    await waitForAppReady(window);

    await openTokenCountingSettings(homePage, settingsPage);
    await expect(window.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  test('confirm path clears persisted state and reloads cleanly', async ({
    window,
    homePage,
    electronApp,
    electronHarness,
  }) => {
    await updateSettingsTestOverrides(window, { accurateRuntimeAvailable: true });
    const userDataDir = await electronApp.app.evaluate(async ({ app }) => app.getPath('userData'));
    const staleMcpDir = path.join(userDataDir, 'mcp');
    const staleCacheDir = path.join(userDataDir, 'Cache');
    const sentinelDir = path.join(userDataDir, 'factory-reset-sentinel');
    const logsDir = path.join(userDataDir, 'logs');
    const staleMcpFile = path.join(staleMcpDir, 'tool-preferences.json');
    const staleCacheFile = path.join(staleCacheDir, 'stale-cache-entry');
    const sentinelFile = path.join(sentinelDir, 'stale-state');
    const diagnosticFile = path.join(logsDir, 'factory-reset-diagnostic.log');
    fs.mkdirSync(staleMcpDir, { recursive: true });
    fs.mkdirSync(staleCacheDir, { recursive: true });
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(staleMcpFile, '{}', 'utf8');
    fs.writeFileSync(staleCacheFile, 'stale', 'utf8');
    fs.writeFileSync(sentinelFile, 'stale', 'utf8');
    fs.writeFileSync(diagnosticFile, 'keep', 'utf8');

    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    const tokenToggle = window.getByTestId('token-counting-accurate-toggle');
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');

    await openFactoryResetSettings(homePage, settingsPage);
    await overrideNextConfirm(window, true);
    await window.getByTestId('factory-reset-button').click();
    await expect
      .poll(() => fs.existsSync(sentinelFile), {
        timeout: 10_000,
      })
      .toBe(false);

    const restarted = await electronHarness.restart();
    const restartedWindow = restarted.window;
    const restartedHomePage = new HomePage(restartedWindow);
    const restartedSettingsPage = new SettingsPage(restartedWindow);

    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(restartedWindow);

    await openTokenCountingSettings(restartedHomePage, restartedSettingsPage);
    await expect(restartedWindow.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(fs.existsSync(sentinelFile)).toBe(false);
    expect(fs.existsSync(diagnosticFile)).toBe(true);
  });
});
