/**
 * Desktop E2E (BST-1990): a host thread whose folder was removed from the
 * workspace can be repaired from its own folder menu. The host keeps refusing a
 * run while any bound folder is gone, so the refusal must name that folder, the
 * chip must mark it, and the chip's repair actions must write a binding the host
 * accepts. The first test is the stuck-primary repro from the #3572 smoke (U8).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostRootRecords, readHostThreadTree, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { openFolderRows } from './utils/where-control';

const API_KEY = 'test-key-host-removed-folder';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const REMOVED = 'Closed';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

function lastUserMessage({ messages }: ModelProviderRequest): string {
  const isUser = (message: unknown): boolean =>
    Boolean(message && typeof message === 'object' && 'role' in message && message.role === 'user');
  return JSON.stringify(messages.filter(isUser).at(-1));
}

/** The durable `roots.id` of a folder, from the app's own database. */
async function rootIdOf(page: Page, rootPath: string): Promise<string> {
  const userData = await page.evaluate(() => window.electronAPI!.getUserDataPath());
  const rows = (await readHostRootRecords(userData)).filter((root) => root.path === rootPath);
  if (rows.length !== 1 || !rows[0]) {
    throw new Error(`Expected one canonical root for ${rootPath}`);
  }
  return rows[0].id;
}

/** Remove a folder from the workspace with the explorer's own control, keeping its data. */
async function removeFromWorkspace(page: Page, name: string): Promise<void> {
  const row = page.getByTestId('root-section-header-row').filter({ hasText: name });
  await row.hover();
  await row.getByTestId('root-section-disconnect').click();
  await page.getByRole('dialog').getByRole('button', { exact: true, name: 'Disconnect' }).click();
  await expect(page.getByTestId('root-section-header-row').filter({ hasText: name })).toHaveCount(
    0,
    {
      timeout: 30_000,
    }
  );
}

function chip(region: Locator): Locator {
  return region.getByTestId('workspace-bar-where-chip');
}

/**
 * Open a thread folder's submenu in the where-control: in its Folders
 * submenu while the thread has a live primary folder, in the where-menu
 * itself while it has none. A previous menu selection is
 * still dismissing (exit animation, then focus returns to its trigger); a
 * reopen inside that window is closed by the returning focus. The focus moves
 * a task after the menu unmounts, later still on a loaded runner, so wait for
 * the focus itself, not only for the menu to be gone.
 *
 * The submenu opens from the keyboard, as in the unavailable-root spec. Opened
 * by a click, the pointer stays on its trigger, and moving it to an item while
 * the submenu is still animating in can leave the menu's pointer grace area and
 * close it under the click (BST-2302).
 */
async function openRootMenu(page: Page, region: Locator, rootId: string): Promise<Locator> {
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(chip(region)).toBeFocused();
  await chip(region).click();
  const folders = page.getByTestId('workspace-bar-folders');
  if (await folders.isVisible()) {
    await openSubmenu(page, folders);
  }
  return await openSubmenu(page, page.getByTestId(`workspace-bar-root-${rootId}`));
}

/** Open a where-menu submenu from its trigger with the keyboard. */
async function openSubmenu(page: Page, trigger: Locator): Promise<Locator> {
  await trigger.focus();
  await page.keyboard.press('ArrowRight');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return trigger;
}

/** Choose a submenu item with the keyboard, without moving the pointer. */
async function chooseMenuItem(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).focus();
  await page.keyboard.press('Enter');
}

async function readBinding(userDataDir: string): Promise<Record<string, unknown> | null> {
  const root = (await readHostThreadTree(userDataDir)).find(
    ({ parentThreadId }) => parentThreadId === undefined
  );
  if (!root) {
    throw new Error('The host committed no root thread');
  }
  const { binding } = await withAppHost(userDataDir, async (client) =>
    client.request('thread/workspace/binding/read', { threadId: root.threadId })
  );
  return binding;
}

test('a thread whose primary folder was removed names it, marks it, and recovers with Make primary', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  writeFileSync(path.join(alphaRoot, 'alpha-only.txt'), 'alpha\n');
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-removed-primary-')));
  const bravoName = path.basename(bravoRoot);
  writeFileSync(path.join(bravoRoot, 'bravo-only.txt'), 'bravo\n');
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha-only.txt').first()).toBeVisible({ timeout: 60_000 });
    await enableModel(page);
    modelProvider.setScript((request) => {
      const turn = /REMOVED_FOLDER_TURN_(\d)/u.exec(lastUserMessage(request))?.[1];
      return { finalText: turn ? `REMOVED_FOLDER_REPLY_${turn}` : 'Removed folder' };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const send = async (turn: number): Promise<void> => {
      await region
        .getByRole('textbox', { name: 'Message input' })
        .fill(`REMOVED_FOLDER_TURN_${turn}: hello`);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
    };

    // The thread binds folder A, which the person chose, on its first run.
    await chooseThreadFolder(region, path.basename(alphaRoot));
    await send(1);
    await expect(region.getByText('REMOVED_FOLDER_REPLY_1')).toBeVisible({ timeout: 90_000 });
    const alphaId = await rootIdOf(page, alphaRoot);

    // Folder B joins the thread from its Folders menu, then becomes the thread's primary.
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await openFolderRows(region);
    await page.getByTestId('workspace-bar-add-folder').click();
    await expect(chip(region)).toHaveAttribute('aria-label', /, 1 more$/u, { timeout: 30_000 });
    const bravoId = await rootIdOf(page, bravoRoot);
    await openRootMenu(page, region, bravoId);
    await chooseMenuItem(page, `workspace-bar-make-primary-${bravoId}`);
    await expect(chip(region)).toHaveAttribute(
      'aria-label',
      new RegExp(`^Where this thread works: ${bravoName}`, 'u')
    );

    // B leaves the workspace. The send is refused with B's name, not a catalog error.
    await removeFromWorkspace(page, bravoName);
    await send(2);
    const refusal = page.getByRole('alert', { name: 'Agent command error' });
    await expect(refusal).toContainText(`The folder "${bravoName}" is closed.`, {
      timeout: 30_000,
    });
    // Nothing was admitted, so the composer has the message back to resend (D4).
    await expect(region.getByRole('textbox', { name: 'Message input' })).toHaveValue(
      'REMOVED_FOLDER_TURN_2: hello'
    );
    await refusal.getByRole('button', { name: 'Dismiss' }).click();

    // The where-control marks B, and Make primary on A drops B in the same write.
    await chip(region).click();
    await expect(page.getByTestId(`workspace-bar-root-${bravoId}`)).toContainText(REMOVED);
    await page.keyboard.press('Escape');
    await openRootMenu(page, region, alphaId);
    await chooseMenuItem(page, `workspace-bar-make-primary-${alphaId}`);
    await expect(chip(region)).toHaveAttribute(
      'aria-label',
      `Where this thread works: ${path.basename(alphaRoot)}`
    );

    await send(3);
    await expect(region.getByText('REMOVED_FOLDER_REPLY_3')).toBeVisible({ timeout: 90_000 });
    const binding = await readBinding(electron.getUserDataDir());
    expect(binding?.['operatingRootId']).toBe(alphaId);
    expect(binding?.['secondaryRootIds'] ?? []).toEqual([]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});

test('a thread left with no live folder offers another workspace folder', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  const alphaName = path.basename(alphaRoot);
  writeFileSync(path.join(alphaRoot, 'alpha-only.txt'), 'alpha\n');
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-removed-only-')));
  writeFileSync(path.join(bravoRoot, 'bravo-only.txt'), 'bravo\n');
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha-only.txt').first()).toBeVisible({ timeout: 60_000 });
    // B is a workspace folder, but not one of the thread's.
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo-only.txt').first()).toBeVisible({ timeout: 60_000 });
    await enableModel(page);
    modelProvider.setScript((request) => {
      const turn = /REMOVED_ONLY_TURN_(\d)/u.exec(lastUserMessage(request))?.[1];
      return { finalText: turn ? `REMOVED_ONLY_REPLY_${turn}` : 'Removed only' };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const send = async (turn: number): Promise<void> => {
      await region
        .getByRole('textbox', { name: 'Message input' })
        .fill(`REMOVED_ONLY_TURN_${turn}: hello`);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
    };

    await chooseThreadFolder(region, alphaName);
    await send(1);
    await expect(region.getByText('REMOVED_ONLY_REPLY_1')).toBeVisible({ timeout: 90_000 });
    const alphaId = await rootIdOf(page, alphaRoot);
    const bravoId = await rootIdOf(page, bravoRoot);
    expect((await readBinding(electron.getUserDataDir()))?.['operatingRootId']).toBe(alphaId);

    // A, the thread's only folder, leaves the workspace.
    await removeFromWorkspace(page, alphaName);
    await send(2);
    const refusal = page.getByRole('alert', { name: 'Agent command error' });
    await expect(refusal).toContainText(`The folder "${alphaName}" is closed.`, {
      timeout: 30_000,
    });
    await refusal.getByRole('button', { name: 'Dismiss' }).click();

    // With no live folder left, the where-control offers the workspace's other folders.
    await chip(region).click();
    await expect(page.getByTestId(`workspace-bar-root-${alphaId}`)).toContainText(REMOVED);
    await openSubmenu(page, page.getByTestId('workspace-bar-use-another-folder'));
    await chooseMenuItem(page, `workspace-bar-use-folder-${bravoRoot}`);
    await expect(chip(region)).toHaveAttribute(
      'aria-label',
      `Where this thread works: ${path.basename(bravoRoot)}`
    );

    await send(3);
    await expect(region.getByText('REMOVED_ONLY_REPLY_3')).toBeVisible({ timeout: 90_000 });
    const binding = await readBinding(electron.getUserDataDir());
    expect(binding?.['operatingRootId']).toBe(bravoId);
    expect(binding?.['secondaryRootIds'] ?? []).toEqual([]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
