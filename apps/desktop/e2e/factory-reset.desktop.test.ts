import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateSettingsTestOverrides } from '@brainstrike/e2e-test-utils/settings-test-overrides';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { captureResetLogs } from './utils/reset-log-capture';
import { readNativeResetProbe, seedNativeResetProbe } from './utils/reset-seed-helpers';
import { textReadiness } from './utils/text-search-mode';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FACTORY_RESET_BROWSER_CACHE_NAME = 'brainstrike-reset-e2e-cache';
const FACTORY_RESET_BROWSER_CACHE_ENTRY_URL = 'https://brainstrike.local/reset-e2e-cache-entry';
const FACTORY_RESET_BROWSER_DB_NAME = 'brainstrike-reset-e2e-indexed-db';
const FACTORY_RESET_LOCAL_STORAGE_KEY = 'brainstrike:reset:e2e:local-storage';
const FACTORY_RESET_SESSION_STORAGE_KEY = 'brainstrike:reset:e2e:session-storage';
const AFTER_RESET_REPLY = 'The fresh profile answers.';

async function openTokenCountingSettings(
  homePage: HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/Token Counting/iu, 'token-counting');
}

/** Answer the native reset confirmation once, then restore it. */
async function confirmNextReset(window: Page): Promise<void> {
  await window.evaluate(() => {
    const original = globalThis.confirm;
    globalThis.confirm = () => {
      globalThis.confirm = original;
      return true;
    };
  });
}

/** Main's saved workspace folders, from its own file under userData: the open list and the recent list. */
function readFolders(userDataDir: string): unknown[] {
  const ledgerFile = path.join(userDataDir, 'electron-storage.json');
  const ledgers: Record<string, string> = fs.existsSync(ledgerFile)
    ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    : {};
  return ['rootsList', 'recentRootsList'].map((key): unknown =>
    ledgers[key] === undefined ? [] : JSON.parse(ledgers[key])
  );
}

async function storedCredentials(window: Page): Promise<string[]> {
  return await window.evaluate(() =>
    (globalThis as unknown as { secrets: { listStored(): Promise<string[]> } }).secrets.listStored()
  );
}

async function seedBrowserPersistentState(window: Page): Promise<void> {
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

async function readBrowserPersistentState(window: Page): Promise<{
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
  window: Page
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
  test.skip(
    process.platform === 'win32',
    'Windows Factory Reset is disabled for M3 by owner decision.'
  );

  // One journey: a used profile with 2 folders, a saved key, settings, a host-kept policy and
  // browser storage; Factory Reset clears all of it, keeps logs and the folders' own files,
  // and the fresh profile stays fresh after a full reopen.
  test('confirm path clears persisted state and reloads cleanly', async ({
    window,
    homePage,
    electronApp,
    electronHarness,
    modelProvider,
  }, testInfo) => {
    const logs = captureResetLogs();
    logs.observeApp(electronApp.app);
    await updateSettingsTestOverrides(window, { accurateRuntimeAvailable: true });
    const userDataDir = await electronApp.app.evaluate(async ({ app }) => app.getPath('userData'));
    const staleMcpDir = path.join(userDataDir, 'mcp');
    const staleCacheDir = path.join(userDataDir, 'Cache');
    const sentinelDir = path.join(userDataDir, 'factory-reset-sentinel');
    const logsDir = path.join(userDataDir, 'logs');
    const sentinelFile = path.join(sentinelDir, 'stale-state');
    const diagnosticFile = path.join(logsDir, 'factory-reset-diagnostic.log');
    for (const dir of [staleMcpDir, staleCacheDir, sentinelDir, logsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(staleMcpDir, 'tool-preferences.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(staleCacheDir, 'stale-cache-entry'), 'stale', 'utf8');
    fs.writeFileSync(sentinelFile, 'stale', 'utf8');
    fs.writeFileSync(diagnosticFile, 'keep', 'utf8');
    await seedBrowserPersistentState(window);

    // Two folders: the first opened with the workspace, the second added from the Explorer.
    const firstRoot = await electronApp.app.evaluate(
      () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH']
    );
    if (!firstRoot) {
      throw new Error('Disposable workspace fixture missing');
    }
    const secondRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'brainstrike-reset-root-'))
    );
    const roots = [firstRoot, secondRoot];
    try {
      for (const [index, root] of roots.entries()) {
        fs.writeFileSync(
          path.join(root, `reset-folder-${index}.txt`),
          'external workspace survives reset',
          'utf8'
        );
      }
      const resetProbe = await seedNativeResetProbe(window, firstRoot);
      await expect(window.getByText('reset-folder-0.txt', { exact: true })).toBeVisible();
      await electronApp.app.evaluate((_electron, rootPath) => {
        process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = rootPath;
      }, secondRoot);
      await window.getByRole('button', { exact: true, name: 'Add Folder to Workspace' }).click();
      await expect(window.getByText('reset-folder-1.txt', { exact: true })).toBeVisible();
      // The Explorer is renderer state: wait for the index's own readiness of both folders,
      // since the new folder opens the next index generation (BST-2152).
      await expect
        .poll(() => textReadiness(window), { timeout: 60_000 })
        .toEqual({ folders: 2, indexMode: 'text-only', kind: 'ready' });
      expect(await readNativeResetProbe(window, resetProbe)).toEqual({
        folders: 2,
        retainedProbeIds: [resetProbe.indexedFileId],
      });
      const mounted = readFolders(userDataDir);
      expect(mounted[0]).toHaveLength(roots.length);
      expect(mounted[1]).toHaveLength(roots.length);

      await configureAssistantProvider(window);
      expect(await storedCredentials(window)).toContain('openai');

      const settingsPage = new SettingsPage(window);
      await openTokenCountingSettings(homePage, settingsPage);
      const tokenToggle = window.getByTestId('token-counting-accurate-toggle');
      await tokenToggle.click();
      await expect(tokenToggle).toHaveAttribute('aria-checked', 'false');
      // A saved permission policy, which the agent host keeps (BST-1930 stage e).
      await homePage.openSettings();
      await settingsPage.openCategory(/Permissions/iu, 'permissions');
      await window.getByTestId('permission-policy-edit').selectOption('deny');
      await expect(window.getByTestId('permission-policy-edit')).toHaveValue('deny');

      await homePage.openSettings();
      await settingsPage.openCategory(/Factory Reset/iu, 'factory-reset');
      await confirmNextReset(window);
      // The retired document stays visually ready while Main purges its stores.
      // Join the replacement document before consulting its readiness or catalog.
      await Promise.all([
        window.waitForEvent('load', { predicate: (loaded) => loaded.url() !== 'about:blank' }),
        window.getByTestId('factory-reset-button').click(),
      ]);
      await expect.poll(() => fs.existsSync(sentinelFile), { timeout: 10_000 }).toBe(false);
      await expect
        .poll(() => readBrowserPersistentStateOrNull(window), { timeout: 10_000 })
        .toEqual({
          cacheExists: false,
          dbExists: false,
          localStorageValue: null,
          sessionStorageValue: null,
        });
      const { waitForAppReady } = await loadElectronHelpers();
      await waitForAppReady(window);
      expect(await readNativeResetProbe(window, resetProbe)).toEqual({ folders: 0 });
      await expect.poll(() => readFolders(userDataDir)).toEqual([[], []]);
      await homePage.leaveSettings();
      for (const index of roots.keys()) {
        await expect(window.getByText(`reset-folder-${index}.txt`, { exact: true })).toHaveCount(0);
      }
      // The replacement window loaded while the profile was closed; it learns the fresh
      // profile's config from Main once the profile reopens, without a restart.
      await expect(window.getByTestId('indexing-status-value')).toHaveText('Ready');
      await homePage.openSettings();
      const searchSettings = await settingsPage.openCategory(
        /Search & Indexing/iu,
        'search-indexing'
      );
      await expect(
        searchSettings
          .getByRole('group', { name: 'Search mode' })
          .getByRole('button', { name: /^Text/u })
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(searchSettings).not.toContainText('The search index is closed');

      const restarted = (await electronHarness.restart(logs.observeApp)).window;
      const restartedHomePage = new HomePage(restarted);
      const restartedSettingsPage = new SettingsPage(restarted);
      await waitForAppReady(restarted);
      expect(await readNativeResetProbe(restarted, resetProbe)).toEqual({ folders: 0 });
      expect(readFolders(userDataDir)).toEqual([[], []]);
      expect(await storedCredentials(restarted)).toEqual([]);
      await restartedHomePage.leaveSettings();
      for (const [index, root] of roots.entries()) {
        await expect(restarted.getByText(`reset-folder-${index}.txt`, { exact: true })).toHaveCount(
          0
        );
        expect(fs.readFileSync(path.join(root, `reset-folder-${index}.txt`), 'utf8')).toBe(
          'external workspace survives reset'
        );
      }
      await openTokenCountingSettings(restartedHomePage, restartedSettingsPage);
      await expect(restarted.getByTestId('token-counting-accurate-toggle')).toHaveAttribute(
        'aria-checked',
        'true'
      );
      await expect
        .poll(() => readBrowserPersistentState(restarted))
        .toEqual({
          cacheExists: false,
          dbExists: false,
          localStorageValue: null,
          sessionStorageValue: null,
        });
      expect(fs.existsSync(sentinelFile)).toBe(false);
      expect(fs.existsSync(diagnosticFile)).toBe(true);
      // The reset cleared the saved policy with the host's state: the default applies again.
      await restartedHomePage.openSettings();
      await restartedSettingsPage.openCategory(/Permissions/iu, 'permissions');
      await expect(restarted.getByTestId('permission-policy-edit')).toHaveValue('ask');
      // The fresh profile still runs an assistant turn once a key is saved again.
      await configureAssistantProvider(restarted);
      modelProvider.setScript({ finalText: AFTER_RESET_REPLY });
      await ensureAssistantShellVisible(restarted);
      const assistant = restarted.getByRole('region', { exact: true, name: 'Assistant' });
      await assistant.getByRole('textbox', { name: 'Message input' }).fill('Hello after reset.');
      await assistant.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(assistant.getByText(AFTER_RESET_REPLY, { exact: true })).toBeVisible({
        timeout: E2E_TIMEOUTS.messageVisibility,
      });
    } finally {
      // Capture ordinary shutdown too; a known-looking shutdown error still fails.
      try {
        await electronHarness.dispose();
        await logs.join();
      } finally {
        await logs.attach(testInfo);
        logs.assertClean();
      }
      fs.rmSync(secondRoot, { force: true, recursive: true });
    }
  });
});
