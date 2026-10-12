/**
 * Desktop E2E (BST-1988): text search is the default and needs no embedding
 * model. On a fresh profile, adding a folder and choosing Text search makes
 * Explorer Text search and the agent's grepSearch read the native text index;
 * no model is chosen, no collection is invented and nothing is downloaded.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';
import { chooseTextSearch, textReadiness } from './utils/text-search-mode';

const API_KEY = 'test-key-text-search-fresh-profile';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const MARKER = 'textfirst-marker-1988';
const REPLY = 'The text search ran.';
const PREFERENCES_KEY = 'background-indexing-preferences.v1';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

/** The assistant's chat model (not an embedding model) for the agent's grepSearch call. */
async function enableChatModel(page: Page): Promise<void> {
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

/** What the fresh profile chose: saved preferences and every embedding collection row. */
async function savedChoices(page: Page): Promise<{ collections: unknown[]; state: unknown }> {
  return await page.evaluate(async (key) => {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('The desktop bridge is unavailable');
    }
    const saved = await api.storage.getItem(key);
    const collections = await api.db.query('SELECT id, model_id FROM embedding_sets');
    return {
      collections: collections.rows,
      state: saved ? (JSON.parse(saved) as { state: unknown }).state : null,
    };
  }, PREFERENCES_KEY);
}

/** Model weights anywhere in the profile: an embedding model download leaves `.onnx` files. */
function downloadedModelFiles(userDataDir: string): string[] {
  return readdirSync(userDataDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.onnx'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('a fresh profile text-searches a folder with no embedding model chosen', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(360_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-text-first-')));
  writeFileSync(path.join(root, 'notes.txt'), `first line\n${MARKER} in the notes\n`);
  writeFileSync(path.join(root, 'other.txt'), 'nothing to find here\n');
  try {
    await seedRoot(page, root, { reloadReason: 'm6-text-first-root', rootId: randomUUID() });
    await enableChatModel(page);
    await chooseTextSearch(page);

    // The native text index builds for the folder without a collection or model.
    await expect
      .poll(() => textReadiness(page), { timeout: 120_000 })
      .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });

    // Every readiness surface says Text search is ready; only semantic search needs a model.
    await expect(page.getByTestId('indexing-status-value')).toHaveText('Ready', {
      timeout: 30_000,
    });
    await page.getByTestId('indexing-status-trigger').first().click();
    const popover = page.getByTestId('indexing-status-popover');
    await expect(popover).toContainText('Text search');
    await expect(popover.getByTestId('managed-stat-files')).toHaveText('2');
    await expect(popover).toContainText('Not used by Text search');
    await expect(popover).not.toContainText('Setup required');
    await expect(popover).not.toContainText('set up a collection');
    await page.keyboard.press('Escape');
    const home = new HomePage(page);
    await home.openSettings();
    const settings = await new SettingsPage(page).openCategory(
      /Search & Indexing/i,
      'search-indexing'
    );
    await expect(settings).toContainText('Collection: Not used by Text search');
    await expect(settings).not.toContainText('Setup required');
    await expect(settings).not.toContainText('set up a collection');
    await home.leaveSettings();
    expect(await savedChoices(page)).toEqual({
      collections: [],
      state: expect.objectContaining({
        managedCollectionId: null,
        nativeIndexMode: 'TEXT',
        nativeLocalSelection: null,
      }),
    });

    // Explorer Text search finds the marker through the index.
    await ensureFileExplorerPanelVisible(page);
    await page
      .getByRole('tablist', { name: 'Explorer and search' })
      .getByRole('tab', { name: 'Search' })
      .click();
    const searchPanel = page.getByTestId('explorer-search-panel-search');
    await searchPanel.getByPlaceholder('Search workspace').fill(MARKER);
    await expect(searchPanel.getByText('notes.txt').first()).toBeVisible({ timeout: 30_000 });
    await expect(searchPanel.getByRole('alert')).toHaveCount(0);

    // The agent's grepSearch reads the same index.
    modelProvider.setScript((request) => {
      const grep = request.toolNames.find((tool) => tool.endsWith('grepSearch'));
      return grep
        ? {
            finalText: REPLY,
            toolCall: { arguments: { outputMode: 'files', pattern: MARKER }, name: grep },
          }
        : { finalText: `No grep tool offered: ${request.toolNames.join(', ')}` };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Find the marker.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
    const tabId =
      (await page
        .getByRole('tablist', { name: 'Open assistant threads' })
        .getByRole('tab', { selected: true })
        .getAttribute('id')) ?? '';
    const threadId = tabId.replace('assistant-thread-tab-', '');
    await expect
      .poll(async () => (await readCommittedRuns(electron.getUserDataDir(), threadId))[0]?.status, {
        timeout: 30_000,
      })
      .toBe('completed');
    const [run] = await readCommittedRuns(electron.getUserDataDir(), threadId);
    expect(run?.results[0]?.output).toMatchObject({
      files: [
        expect.objectContaining({
          path: 'notes.txt',
          source: expect.stringMatching(/^(index|both)$/),
        }),
      ],
      outputMode: 'files',
    });

    // No model was chosen, so none was downloaded.
    expect(downloadedModelFiles(electron.getUserDataDir())).toEqual([]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
