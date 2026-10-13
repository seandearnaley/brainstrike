/**
 * Desktop E2E (BST-1990): a folder removed from the workspace and added back is
 * the same folder. Main's root registry records it under its one `roots.id`, so
 * focusing the re-added folder and sending is admitted, including after a
 * reload. Before, the re-add minted a second id that admission could not match:
 * "The selected workspace root is no longer mounted".
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';

const API_KEY = 'test-key-host-readd-folder';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const REFUSAL = 'The selected workspace root is no longer mounted';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = window.electronAPI?.db;
    if (!db) {
      throw new Error('The app database query path is unavailable');
    }
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

function lastUserMessage({ messages }: ModelProviderRequest): string {
  const users = messages.filter(
    (message) =>
      message && typeof message === 'object' && 'role' in message && message.role === 'user'
  );
  return JSON.stringify(users.at(-1));
}

/** Every `roots` row for a folder path: one record, its id and status. */
async function rootRows(page: Page, rootPath: string): Promise<{ id: string; status: string }[]> {
  return await page.evaluate(async (wanted) => {
    const db = window.electronAPI?.db;
    if (!db) {
      throw new Error('The app database query path is unavailable');
    }
    const { rows } = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM roots WHERE path = $1',
      [wanted]
    );
    return rows;
  }, rootPath);
}

/** Focus a workspace folder in the explorer, as any click inside its section does. */
async function focusFolder(page: Page, name: string): Promise<void> {
  const row = page.getByTestId('root-section-header-row').filter({ hasText: name });
  if ((await row.getAttribute('data-focused')) !== 'true') {
    const header = row.getByTestId('root-section-header');
    await header.click();
    await header.click();
  }
  await expect(row).toHaveAttribute('data-focused', 'true');
}

test('a removed folder added back keeps its one id, and sending with it focused is admitted', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  // Folder A is the folder the harness's picker mounts first; folder B is added second.
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  writeFileSync(path.join(alphaRoot, 'alpha.txt'), 'alpha\n');
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-readd-folder-')));
  writeFileSync(path.join(bravoRoot, 'bravo-only.txt'), 'bravo\n');
  const bravoName = path.basename(bravoRoot);
  const addBravo = async (): Promise<void> => {
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo-only.txt').first()).toBeVisible({ timeout: 60_000 });
  };
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha.txt').first()).toBeVisible({ timeout: 60_000 });
    await addBravo();
    const [bravoRecord] = await rootRows(page, bravoRoot);
    expect(bravoRecord?.status).toBe('live');

    await enableModel(page);
    modelProvider.setScript((request) => {
      const turn = /READD_TURN_(\d)/u.exec(lastUserMessage(request))?.[1];
      return { finalText: turn ? `READD_REPLY_${turn}` : 'Re-add' };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const send = async (turn: number): Promise<void> => {
      await region.getByRole('textbox', { name: 'Message input' }).fill(`READD_TURN_${turn}`);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(region.getByText(`READD_REPLY_${turn}`)).toBeVisible({ timeout: 90_000 });
      await expect(region.getByText(REFUSAL)).toHaveCount(0);
    };
    // The thread binds to A on its first send.
    await send(1);

    // Disconnect B, keeping its indexed data, then add the same folder back.
    const bravoHeader = page.getByTestId('root-section-header-row').filter({ hasText: bravoName });
    await bravoHeader.hover();
    await bravoHeader.getByTestId('root-section-disconnect').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { exact: true, name: 'Disconnect' }).click();
    await expect(bravoHeader).toHaveCount(0, { timeout: 30_000 });
    expect(await rootRows(page, bravoRoot)).toEqual([
      { id: bravoRecord?.id, status: 'disconnected' },
    ]);
    await addBravo();

    // One record, the same id, live again.
    expect(await rootRows(page, bravoRoot)).toEqual([{ id: bravoRecord?.id, status: 'live' }]);
    await focusFolder(page, bravoName);
    await send(2);

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'bst-1990-readd-reload');
    await ensureAssistantShellVisible(page);
    await focusFolder(page, bravoName);
    await send(3);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
