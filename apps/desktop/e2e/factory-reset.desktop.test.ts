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

const FACTORY_RESET_BROWSER_CACHE_NAME = 'brainstrike-reset-e2e-cache';
const FACTORY_RESET_BROWSER_CACHE_ENTRY_URL = 'https://brainstrike.local/reset-e2e-cache-entry';
const FACTORY_RESET_BROWSER_DB_NAME = 'brainstrike-reset-e2e-indexed-db';
const FACTORY_RESET_LOCAL_STORAGE_KEY = 'brainstrike:reset:e2e:local-storage';
const FACTORY_RESET_SESSION_STORAGE_KEY = 'brainstrike:reset:e2e:session-storage';

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

async function seedBrowserPersistentState(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(
    async ({ cacheEntryUrl, cacheName, dbName, localStorageKey, sessionStorageKey }) => {
      localStorage.setItem(localStorageKey, 'stale');
      sessionStorage.setItem(sessionStorageKey, 'stale');

      if (typeof caches !== 'undefined') {
        const cache = await caches.open(cacheName);
        await cache.put(cacheEntryUrl, new Response('stale'));
      }

      if (typeof indexedDB !== 'undefined') {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(dbName, 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore('stale-store');
          };
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error ?? new Error('IndexedDB seed failed'));
          request.onblocked = () => reject(new Error('IndexedDB seed was blocked'));
        });
      }
    },
    {
      cacheEntryUrl: FACTORY_RESET_BROWSER_CACHE_ENTRY_URL,
      cacheName: FACTORY_RESET_BROWSER_CACHE_NAME,
      dbName: FACTORY_RESET_BROWSER_DB_NAME,
      localStorageKey: FACTORY_RESET_LOCAL_STORAGE_KEY,
      sessionStorageKey: FACTORY_RESET_SESSION_STORAGE_KEY,
    }
  );
}

async function readBrowserPersistentState(window: import('@playwright/test').Page): Promise<{
  cacheExists: boolean;
  dbExists: boolean | null;
  localStorageValue: string | null;
  sessionStorageValue: string | null;
}> {
  return await window.evaluate(
    async ({ cacheName, dbName, localStorageKey, sessionStorageKey }) => {
      const cacheExists =
        typeof caches === 'undefined' ? false : (await caches.keys()).includes(cacheName);
      const dbExists =
        typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function'
          ? (await indexedDB.databases()).some((entry) => entry.name === dbName)
          : null;

      return {
        cacheExists,
        dbExists,
        localStorageValue: localStorage.getItem(localStorageKey),
        sessionStorageValue: sessionStorage.getItem(sessionStorageKey),
      };
    },
    {
      cacheName: FACTORY_RESET_BROWSER_CACHE_NAME,
      dbName: FACTORY_RESET_BROWSER_DB_NAME,
      localStorageKey: FACTORY_RESET_LOCAL_STORAGE_KEY,
      sessionStorageKey: FACTORY_RESET_SESSION_STORAGE_KEY,
    }
  );
}

async function readBrowserPersistentStateOrNull(
  window: import('@playwright/test').Page
): Promise<Awaited<ReturnType<typeof readBrowserPersistentState>> | null> {
  try {
    return await readBrowserPersistentState(window);
  } catch {
    // The factory reset flow reloads the renderer after clearing browser storage.
    // During that navigation Playwright can briefly lose the execution context.
    return null;
  }
}

test.describe('Factory Reset settings (desktop) @destructive @desktop-ipc-reset', () => {
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
    await seedBrowserPersistentState(window);

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
    await expect
      .poll(() => readBrowserPersistentStateOrNull(window), {
        timeout: 10_000,
      })
      .toEqual({
        cacheExists: false,
        dbExists: false,
        localStorageValue: null,
        sessionStorageValue: null,
      });

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
    await expect
      .poll(() => readBrowserPersistentState(restartedWindow))
      .toEqual({
        cacheExists: false,
        dbExists: false,
        localStorageValue: null,
        sessionStorageValue: null,
      });
    expect(fs.existsSync(sentinelFile)).toBe(false);
    expect(fs.existsSync(diagnosticFile)).toBe(true);
  });
});
