import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FILE_EXPLORER_STORAGE_KEY } from '@brainstrike/file-explorer/testing';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '../fixtures/electron-fixture';
import type { ElectronHarness } from '../fixtures/electron-harness';
import { readHostThreadWorkspace, waitForAppHost } from './agent-host-log';
import { configureAssistantProvider } from './assistant-mock';
import { getContextExplorerFileExplorerPanel } from './context-explorer-locators';
import { updateIndexConfig } from './index-config';
import { ensureAssistantShellVisible } from './layout-helpers';
import { loadElectronHelpers } from './load-electron-helpers';
import { seedWorkspaceLedgers } from './seed-root';

/**
 * The three renderer writers with a write-behind tail (ADR-0026 R1), driven through the real UI
 * and read back from each one's owner: the thread workspace snapshot from the agent host,
 * Explorer persistence from Main's `electron-storage.json`, the panel layout from the profile's
 * localStorage. No transport is patched and no write is held: the contract is "the last write is
 * committed before the document unloads", read where it is committed.
 */
export interface DurableUiFixture {
  /** The folder whose expansion is the Explorer and thread-workspace edit. */
  readonly expandedPath: string;
  readonly rootPath: string;
  readonly threadId: string;
}

const ROOT_ID = 'durable-ui-root-0000-4000-8000-000000000001';
const FOLDER = 'src';
const PANEL_LAYOUT_KEY = 'panel-layout-store.v1';

/**
 * A seeded root with one folder, and one thread whose workspace the host has stored. The root is
 * seeded, then the app relaunches on it: the test's own unload is then the launch's first, which
 * is the one the E2E lifecycle seam's one-shot `renderer-flush` delay applies to.
 *
 * The root lives in the harness's disposable workspace, which the fixture's teardown removes
 * after the app's exit is joined: removing it while the app still has it mounted fails on
 * Windows (EBUSY).
 */
export async function openDurableUiFixture(
  electron: ElectronHarness,
  seedPage: Page
): Promise<DurableUiFixture & { readonly page: Page }> {
  const rootPath = await realpath(
    await mkdtemp(path.join(electron.getWorkspaceRoot(), 'durable-ui-'))
  );
  await mkdir(path.join(rootPath, FOLDER));
  await writeFile(path.join(rootPath, FOLDER, 'index.ts'), 'export const durable = true;\n');
  await seedWorkspaceLedgers(seedPage, {
    lastFolderPath: rootPath,
    recentPaths: [],
    roots: [{ path: rootPath, rootId: ROOT_ID }],
  });
  await updateIndexConfig(seedPage, { paused: true });
  const { window: page } = await electron.restart();
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
  await waitForAppHost(page);
  const userDataDir = electron.getUserDataDir();
  // The click's thread is the panel it activates. The launch opens a thread of its own first, and
  // under load its panel and its host row can both appear after the click, so wait for that
  // launch thread before clicking: the click's thread is then the next active one.
  let previousThreadId: string | null = null;
  await expect
    .poll(async () => {
      previousThreadId = await readActiveThreadId(page);
      return previousThreadId;
    })
    .not.toBeNull();
  await page.getByTestId('assistant-new-thread-button').click();
  let threadId: string | null = null;
  // The thread this click made is the active one once the host has stored its workspace.
  await expect
    .poll(async () => {
      threadId = await readActiveThreadId(page);
      return threadId === null || threadId === previousThreadId
        ? null
        : await readHostThreadWorkspace(userDataDir, threadId);
    })
    .not.toBeNull();
  if (!threadId) {
    throw new Error('The new thread has no stored workspace');
  }
  await expect(folderRow(page).getByRole('button', { name: 'Expand' })).toBeVisible();
  return {
    expandedPath: path.join(rootPath, FOLDER),
    page,
    rootPath,
    threadId,
  };
}

/** The thread of the one visible assistant thread panel, or null while none is shown. */
async function readActiveThreadId(page: Page): Promise<string | null> {
  const panels = page.locator('[data-testid^="assistant-thread-panel-"]:not([hidden])');
  if ((await panels.count()) !== 1) {
    return null;
  }
  const testId = await panels.getAttribute('data-testid');
  return testId ? testId.slice('assistant-thread-panel-'.length) : null;
}

function folderRow(page: Page) {
  return getContextExplorerFileExplorerPanel(page)
    .getByRole('treegrid', { name: 'File tree' })
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: `Select ${FOLDER}` }) });
}

/** Expands the fixture folder: an Explorer persistence edit and a thread-workspace edit. */
export async function expandFixtureFolder(page: Page): Promise<void> {
  await folderRow(page).getByRole('button', { name: 'Expand' }).click();
  await expect(
    getContextExplorerFileExplorerPanel(page)
      .getByRole('treegrid', { name: 'File tree' })
      .getByText('index.ts')
  ).toBeVisible();
}

/** Resizes the first panel with the keyboard: a resize the panel layout commits after 150 ms. */
export async function resizeFirstPanel(page: Page): Promise<void> {
  const separator = page.getByRole('separator', { name: /^Resize .* panel$/u }).first();
  await separator.focus();
  await page.keyboard.press('ArrowRight');
}

export async function readPanelLayout(page: Page): Promise<string | null> {
  return await page.evaluate((key) => localStorage.getItem(key), PANEL_LAYOUT_KEY);
}

/** The expanded folders in Main's own storage file, as the next launch reads them. */
export async function readStoredExplorerExpansion(userDataDir: string): Promise<string[]> {
  const storage = JSON.parse(
    await readFile(path.join(userDataDir, 'electron-storage.json'), 'utf8')
  ) as Record<string, string | undefined>;
  const stored = storage[FILE_EXPLORER_STORAGE_KEY];
  if (stored === undefined) {
    return [];
  }
  const envelope = JSON.parse(stored) as { state?: { expandedDirectoryPaths?: string[] } };
  return envelope.state?.expandedDirectoryPaths ?? [];
}

/** The expanded folders in the thread's snapshot as the agent host has committed it. */
export async function readCommittedThreadExpansion(
  userDataDir: string,
  threadId: string
): Promise<string[]> {
  const snapshot = await readHostThreadWorkspace(userDataDir, threadId);
  return Object.values(snapshot?.explorer.byRoot ?? {}).flatMap((bucket) => bucket.expandedPaths);
}

/** View → Reload, the way the user picks it. */
export async function reloadFromMenu(app: ElectronApplication, page: Page): Promise<void> {
  const id = await (await app.browserWindow(page)).evaluate((window) => window.id);
  await app.evaluate(({ BrowserWindow, Menu }, windowId) => {
    const target = BrowserWindow.fromId(windowId);
    const item = Menu.getApplicationMenu()
      ?.items.find(({ label }) => label === 'View')
      ?.submenu?.items.find(({ label }) => label === 'Reload');
    if (!(target && item)) {
      throw new Error('The app Reload menu target is unavailable');
    }
    item.click(undefined, target, target.webContents);
  }, id);
}

/**
 * The user's window-X on the app's only visible window. macOS keeps the app running without a
 * window; Windows and Linux quit, and this joins that exit and returns its status.
 */
export async function closeLastWindowLikeTheUser(
  electron: ElectronHarness,
  page: Page
): Promise<{ readonly quit: false } | { readonly quit: true; readonly exitCode: number | null }> {
  const { app } = await electron.ensureContext();
  const window = await app.browserWindow(page);
  if (process.platform === 'darwin') {
    const closed = page.waitForEvent('close');
    await window.evaluate((win) => {
      win.close();
    });
    await closed;
    return { quit: false };
  }
  let exitCode: number | null = null;
  await electron.endOutOfBand(async (main) => {
    const exited = once(main, 'exit');
    await window.evaluate((win) => {
      win.close();
    });
    [exitCode] = (await exited) as [number | null];
  });
  return { exitCode, quit: true };
}
