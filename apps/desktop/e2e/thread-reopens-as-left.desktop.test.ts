/**
 * Desktop E2E: a thread opens as it was left. After another folder is opened in the window and
 * the app restarts, opening the thread mounts its folder again without a click and the thread
 * sends: a folder thread even when Recents no longer lists its folder or the folder's record was
 * deleted, and a worktree thread even when the app's record of the worktree was lost while its
 * checkout stayed intact on disk.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { readHostRoot } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { createAndUseWorktree } from './utils/create-worktree';
import type { ElectronAppContext } from './utils/electron-helpers.mts';
import { initRepo } from './utils/git-fixtures';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { whereChip } from './utils/where-control';

const API_KEY = 'test-key-thread-reopens-as-left';
const MODEL = 'anthropic/claude-sonnet-4.6';
const managedDirectory = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'bst-thread-reopens-as-left-'))
);

test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_WORKTREE_DIR: managedDirectory,
    BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY,
  },
});

test.afterAll(() => {
  rmSync(managedDirectory, { force: true, recursive: true });
});

async function enableChatModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    if (!window.modelCatalog) {
      throw new Error('Desktop model catalog is unavailable');
    }
    const result = await window.modelCatalog.setModels([model], true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }, MODEL);
}

async function send(page: Page, prompt: string): Promise<void> {
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill(prompt);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(`ECHO ${prompt}`)).toBeVisible({ timeout: 90_000 });
}

function makeOtherFolder(): string {
  const other = realpathSync(mkdtempSync(path.join(tmpdir(), 'bst-other-folder-')));
  writeFileSync(path.join(other, 'other-file.txt'), 'OTHER\n');
  return other;
}

/** Opens a folder as the window's project through the picker, in place of the open ones. */
async function openFolder(
  page: Page,
  electronApp: ElectronAppContext,
  folder: string,
  fileName: string
): Promise<void> {
  await electronApp.app.evaluate((_electron, next) => {
    process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
  }, folder);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('Open folder');
  await page.keyboard.press('Enter');
  await expect(page.getByText(fileName).first()).toBeVisible({ timeout: 30_000 });
}

/** Opens another folder as the window's project, in place of the thread's folder. */
function openOtherFolder(page: Page, electronApp: ElectronAppContext, other: string) {
  return openFolder(page, electronApp, other, 'other-file.txt');
}

/** The folder's record in the app's store: opening the thread opens it again. */
function folderStatus(stateDb: string, folder: string): string | null {
  const db = new DatabaseSync(stateDb, { readOnly: true });
  try {
    const row = db.prepare('SELECT status FROM roots WHERE path = ?').get(folder);
    return row ? String(row['status']) : null;
  } finally {
    db.close();
  }
}

/** Brings the thread's tab to the front and waits until its folder is open again. */
async function openThread(page: Page, tabId: string, stateDb: string, folder: string) {
  await page.locator(`#${tabId}`).click();
  await expect.poll(() => folderStatus(stateDb, folder), { timeout: 30_000 }).toBe('live');
}

function selectedThreadTab(page: Page) {
  return page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { selected: true });
}

/** A folder thread, left while another folder is open, whose state is changed before the restart. */
async function reopenFolderThread(
  fixtures: {
    readonly electron: ElectronHarness;
    readonly electronApp: ElectronAppContext;
    readonly modelProvider: ModelProviderShim;
    readonly page: Page;
  },
  seed: (db: DatabaseSync, folder: string) => void
): Promise<void> {
  const { electron, electronApp, modelProvider, page } = fixtures;
  const root = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(root).not.toBe('');
  const other = makeOtherFolder();
  modelProvider.setScript((request) => ({
    finalText: `ECHO ${[...JSON.stringify(request.messages).matchAll(/STEP_\d/gu)].at(-1)?.[0] ?? '?'}`,
  }));
  try {
    await ensureMockWorkspaceOpen(page);
    await enableChatModel(page);
    await ensureAssistantShellVisible(page);
    await chooseThreadFolder(page, path.basename(root));
    await send(page, 'STEP_1');
    const tabId = (await selectedThreadTab(page).getAttribute('id')) ?? '';
    await openOtherFolder(page, electronApp, other);

    const stateDb = path.join(await readHostRoot(electron.getUserDataDir()), 'state.db');
    await electron.closeForStateSeeding();
    const db = new DatabaseSync(stateDb);
    try {
      seed(db, root);
    } finally {
      db.close();
    }
    const restarted = (await electron.restart()).window;
    await ensureAssistantShellVisible(restarted);
    await openThread(restarted, tabId, stateDb, root);
    await send(restarted, 'STEP_2');
  } finally {
    await electron.dispose();
    rmSync(other, { force: true, recursive: true });
  }
}

test('a folder thread opens with its folder after Recents forgot it and a restart', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(240_000);
  // Recents keeps only the newest folders; this thread's folder is no longer among them.
  await reopenFolderThread({ electron, electronApp, modelProvider, page }, (db) => {
    db.prepare("DELETE FROM settings WHERE key = 'workspace.recentRootsList'").run();
  });
});

test('a folder thread opens with its folder after the folder record was deleted', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(240_000);
  // The record the thread names is gone (deleted with the folder's data); the folder is not.
  await reopenFolderThread({ electron, electronApp, modelProvider, page }, (db, folder) => {
    expect(db.prepare('DELETE FROM roots WHERE path = ?').run(folder).changes).toBe(1);
  });
});

/**
 * A worktree thread, left while another folder is open, whose worktree record is lost before the
 * restart. With `recordsDeleted`, the folder records of the worktree and its repository are gone
 * too, and the person opens the repository again before opening the thread.
 */
async function reopenWorktreeThread(
  fixtures: {
    readonly electron: ElectronHarness;
    readonly electronApp: ElectronAppContext;
    readonly modelProvider: ModelProviderShim;
    readonly page: Page;
  },
  recordsDeleted: boolean
): Promise<void> {
  const { electron, electronApp, modelProvider, page } = fixtures;
  const root = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(root).not.toBe('');
  initRepo(root);
  const other = makeOtherFolder();
  modelProvider.setScript((request) => ({
    finalText: `ECHO ${[...JSON.stringify(request.messages).matchAll(/STEP_\d/gu)].at(-1)?.[0] ?? '?'}`,
  }));
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('hello.ts').first()).toBeVisible({ timeout: 60_000 });
    await enableChatModel(page);
    await ensureAssistantShellVisible(page);
    await chooseThreadFolder(page, path.basename(root));
    const { name } = await createAndUseWorktree(page);
    await send(page, 'STEP_1');
    const tabId = (await selectedThreadTab(page).getAttribute('id')) ?? '';
    await openOtherFolder(page, electronApp, other);

    // The app loses its record of the worktree; the checkout stays on disk.
    const stateDb = path.join(await readHostRoot(electron.getUserDataDir()), 'state.db');
    await electron.closeForStateSeeding();
    const db = new DatabaseSync(stateDb);
    let worktreeId: unknown;
    let worktreePath = '';
    try {
      const recorded = db.prepare('SELECT id, path FROM brainstrike_worktrees').get();
      worktreeId = recorded?.['id'];
      worktreePath = String(recorded?.['path']);
      expect(db.prepare('DELETE FROM brainstrike_worktrees').run().changes).toBe(1);
      if (recordsDeleted) {
        const deleteRoot = db.prepare('DELETE FROM roots WHERE path = ?');
        expect([deleteRoot.run(root).changes, deleteRoot.run(worktreePath).changes]).toEqual([
          1, 1,
        ]);
      }
    } finally {
      db.close();
    }
    const restartedApp = await electron.restart();
    const restarted = restartedApp.window;
    await ensureAssistantShellVisible(restarted);
    if (recordsDeleted) {
      // Opened first, the thread cannot record its worktree again: its repository is not open.
      await restarted.locator(`#${tabId}`).click();
      await expect(restarted.getByRole('button', { name: "can't be opened" })).toBeVisible({
        timeout: 30_000,
      });
      // Opening the repository through the picker is what the thread was waiting for.
      await openFolder(restarted, restartedApp, root, 'hello.ts');
    }
    // Opening the thread brings its worktree back without a click, and the thread sends.
    await openThread(restarted, tabId, stateDb, worktreePath);
    await send(restarted, 'STEP_2');
    // The where-control names the worktree again, with no warning that it is missing.
    await expect(whereChip(restarted)).toHaveAttribute(
      'aria-label',
      `Where this thread works: ${path.basename(root)} · ${name}`
    );
    const reopened = new DatabaseSync(stateDb, { readOnly: true });
    try {
      // The record is written again under the id the thread names.
      expect(reopened.prepare('SELECT id, archived_at FROM brainstrike_worktrees').all()).toEqual([
        { archived_at: null, id: worktreeId },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    await electron.dispose();
    rmSync(other, { force: true, recursive: true });
  }
}

test('a worktree thread opens with its worktree after another folder and a restart', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(360_000);
  await reopenWorktreeThread({ electron, electronApp, modelProvider, page }, false);
});

test('a worktree thread opens with its worktree after its folder records were deleted', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(360_000);
  await reopenWorktreeThread({ electron, electronApp, modelProvider, page }, true);
});
