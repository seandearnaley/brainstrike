/**
 * Desktop E2E (BST-2001): disconnecting a folder with "Also delete folder
 * data" deletes that folder's record and nothing else. A host run that is
 * still streaming in the thread's bound folder keeps running in the same agent
 * host process, finishes, and the thread pane never reports the host as
 * disconnected.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, readHostRootRecords, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const API_KEY = 'test-key-host-root-data-delete';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const STREAMING = 'ROOT_DELETE_STREAMING_2001';
const FINAL = 'ROOT_DELETE_SURVIVED_2001';
const DISCONNECTED = 'Agent host disconnected. Reconnect to continue.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

/** The durable `roots.id` of a mounted folder, from the app's own database. */
async function rootIdOf(page: Page, rootPath: string): Promise<string> {
  const userData = await page.evaluate(() => window.electronAPI!.getUserDataPath());
  const rows = (await readHostRootRecords(userData)).filter((root) => root.path === rootPath);
  if (rows.length !== 1 || !rows[0]) {
    throw new Error(`Expected one canonical root for ${rootPath}`);
  }
  return rows[0].id;
}

test('deleting another folder’s data leaves a streaming host run running in the same host', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(240_000);
  // Folder A is the folder the harness's picker mounts first and the thread binds to.
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  writeFileSync(path.join(alphaRoot, 'alpha-root-data.txt'), 'alpha\n');
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-root-data-delete-')));
  writeFileSync(path.join(bravoRoot, 'bravo-root-data.txt'), 'bravo\n');
  const hold = Promise.withResolvers<void>();
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha-root-data.txt').first()).toBeVisible({ timeout: 60_000 });
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo-root-data.txt').first()).toBeVisible({ timeout: 60_000 });
    const alphaId = await rootIdOf(page, alphaRoot);
    const bravoId = await rootIdOf(page, bravoRoot);
    expect((await readHostRootRecords(electron.getUserDataDir())).map((root) => root.id)).toEqual(
      [alphaId, bravoId].sort()
    );

    await enableModel(page);
    modelProvider.setScript(() => ({
      beforeFinalText: hold.promise,
      finalText: FINAL,
      streamedBeforeHold: STREAMING,
    }));
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Reply while I tidy folders');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    // The run is mid-stream: its partial reply is on screen and the provider holds the rest.
    await expect(region.getByText(STREAMING)).toBeVisible({ timeout: 90_000 });
    const userDataDir = electron.getUserDataDir();
    const hostBefore = await readHostProcess(userDataDir);

    const bravoName = path.basename(bravoRoot);
    await page
      .getByTestId('root-section-header-row')
      .filter({ hasText: bravoName })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Disconnect…' }).click();
    const dialog = page.getByRole('dialog', { name: `Disconnect ${bravoName}?` });
    await dialog.getByRole('checkbox', { name: 'Also delete folder data' }).check();
    await dialog.getByRole('button', { exact: true, name: 'Disconnect' }).click();
    await expect(dialog).toBeHidden({ timeout: 90_000 });
    // Folder B is gone from the workspace with its record; folder A keeps its own.
    await expect(page.getByText('bravo-root-data.txt')).toHaveCount(0, { timeout: 60_000 });
    await expect
      .poll(async () =>
        (await readHostRootRecords(electron.getUserDataDir())).map((root) => root.id)
      )
      .toEqual([alphaId]);

    hold.resolve();
    await expect(region.getByText(FINAL)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(DISCONNECTED)).toHaveCount(0);
    // The same host process served the whole run: deletion never replaced it.
    expect(await readHostProcess(userDataDir)).toEqual(hostBefore);
    // The reply streams before the run commits its end; the pane leaves the
    // running state once that end is committed.
    await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    const finishedOutcomes = (await readHostThreadTree(userDataDir))
      .filter(({ parentThreadId }) => parentThreadId === undefined)
      .flatMap(({ rows }) =>
        rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
      );
    expect(finishedOutcomes).toEqual(['completed']);
    expect(await readHostProcess(userDataDir)).toEqual(hostBefore);
    await expect(page.getByText(DISCONNECTED)).toHaveCount(0);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    hold.resolve();
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
