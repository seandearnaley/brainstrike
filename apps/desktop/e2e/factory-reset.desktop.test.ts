import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateSettingsTestOverrides } from '@brainstrike/e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { factoryResetAndRelaunch } from './utils/factory-reset';
import { ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { captureResetLogs } from './utils/reset-log-capture';
import { readNativeResetProbe, seedNativeResetProbe } from './utils/reset-seed-helpers';

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
      Reflect.deleteProperty(target, '__brainstrikeOriginalConfirm__');
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
    Reflect.deleteProperty(target, '__brainstrikeOriginalConfirm__');
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

  test('confirm path restarts the app with every setting, file and browser record gone but the logs', async ({
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

    const workspacePath = await electronApp.app.evaluate(
      () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
    );
    const resetProbe = await seedNativeResetProbe(window, workspacePath);
    expect(await readNativeResetProbe(window, resetProbe)).toEqual({
      folders: 1,
      retainedProbeIds: [resetProbe.indexedFileId],
    });

    const settingsPage = new SettingsPage(window);
    await openTokenCountingSettings(homePage, settingsPage);

    const tokenToggle = window.getByTestId('token-counting-accurate-toggle');
    await tokenToggle.click();
    await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');
    // A saved permission policy, which the agent host keeps (BST-1930 stage e).
    await homePage.openSettings();
    await settingsPage.openCategory(/Permissions/i, 'permissions');
    await window.getByTestId('permission-policy-edit').selectOption('deny');
    await expect(window.getByTestId('permission-policy-edit')).toHaveValue('deny');

    // Factory Reset quits the app; the next start wipes everything but the logs before it opens
    // anything, so the user meets a fresh app.
    const restarted = await factoryResetAndRelaunch(electronHarness, window);
    const restartedWindow = restarted.window;
    const restartedHomePage = new HomePage(restartedWindow);
    const restartedSettingsPage = new SettingsPage(restartedWindow);

    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(restartedWindow);
    expect(await readNativeResetProbe(restartedWindow, resetProbe)).toEqual({ folders: 0 });

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
    for (const stale of [sentinelFile, staleMcpFile, staleCacheFile]) {
      expect(fs.existsSync(stale), stale).toBe(false);
    }
    expect(fs.readFileSync(diagnosticFile, 'utf8')).toBe('keep');
    // The reset cleared the saved policy with the host's state: the default applies again.
    await restartedHomePage.openSettings();
    await restartedSettingsPage.openCategory(/Permissions/i, 'permissions');
    await expect(restartedWindow.getByTestId('permission-policy-edit')).toHaveValue('ask');
  });
  for (const folderCount of [1, 2]) {
    test(`reset with ${folderCount} mounted folders reopens with none and leaves their files alone`, async ({
      window,
      electronApp,
      electronHarness,
    }, testInfo) => {
      const logs = captureResetLogs();
      logs.observeApp(electronApp.app);
      const firstRoot = await electronApp.app.evaluate(
        () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH']
      );
      if (!firstRoot) {
        throw new Error('Disposable workspace fixture missing');
      }
      const extraRoots: string[] = [];
      const roots = [firstRoot];
      try {
        for (let index = 1; index < folderCount; index += 1) {
          const root = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'brainstrike-reset-root-'))
          );
          extraRoots.push(root);
          roots.push(root);
        }
        for (const [index, root] of roots.entries()) {
          const fileName = `reset-folder-${index}.txt`;
          fs.writeFileSync(path.join(root, fileName), 'external workspace survives reset', 'utf8');
          await electronApp.app.evaluate((_electron, rootPath) => {
            process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = rootPath;
          }, root);
          if (index === 0) {
            await ensureMockWorkspaceOpen(window);
          } else {
            await window
              .getByRole('button', { exact: true, name: 'Add Folder to Workspace' })
              .click();
          }
          await expect(window.getByText(fileName, { exact: true })).toBeVisible();
        }
        const readFolders = async (page: import('@playwright/test').Page) =>
          await page.evaluate(async () => {
            const storage = (
              globalThis as typeof globalThis & {
                electronAPI?: { storage?: { getItem: (key: string) => Promise<string | null> } };
              }
            ).electronAPI?.storage;
            if (!storage) {
              throw new Error('Desktop storage capability unavailable');
            }
            const values = await Promise.all(
              ['rootsList', 'recentRootsList'].map((key) => storage.getItem(key))
            );
            return values.map((value): unknown => (value === null ? [] : JSON.parse(value)));
          });
        const mounted = await readFolders(window);
        expect(mounted[0]).toHaveLength(folderCount);
        expect(mounted[1]).toHaveLength(folderCount);
        // The user resets a workspace whose folders the index has taken in.
        await expect(window.getByTestId('indexing-status-value')).toHaveText('Ready');
        const reopened = await factoryResetAndRelaunch(electronHarness, window, logs.observeApp);
        const { waitForAppReady } = await loadElectronHelpers();
        await waitForAppReady(reopened.window);
        const reopenedHome = new HomePage(reopened.window);
        await reopenedHome.leaveSettings();
        expect(await readFolders(reopened.window)).toEqual([[], []]);
        await expect(reopened.window.getByTestId('indexing-status-value')).toHaveText('Ready');
        await reopenedHome.openSettings();
        const searchSettings = await new SettingsPage(reopened.window).openCategory(
          /Search & Indexing/i,
          'search-indexing'
        );
        await expect(
          searchSettings
            .getByRole('group', { name: 'Search mode' })
            .getByRole('button', { name: /^Text/ })
        ).toHaveAttribute('aria-pressed', 'true');
        await reopenedHome.leaveSettings();
        for (const [index, root] of roots.entries()) {
          await expect(
            reopened.window.getByText(`reset-folder-${index}.txt`, { exact: true })
          ).toHaveCount(0);
          expect(fs.readFileSync(path.join(root, `reset-folder-${index}.txt`), 'utf8')).toBe(
            'external workspace survives reset'
          );
        }
      } finally {
        // Capture ordinary shutdown too; a known-looking shutdown error still fails.
        try {
          await electronHarness.dispose();
          await logs.join();
        } finally {
          await logs.attach(testInfo);
          logs.assertClean();
        }
        for (const root of extraRoots) {
          fs.rmSync(root, { force: true, recursive: true });
        }
      }
    });
  }
});
