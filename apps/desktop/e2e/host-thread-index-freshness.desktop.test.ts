/**
 * Desktop E2E: a host thread's file edits reach the native workspace index
 * through its own file watcher. The agent host binds the shared write and
 * delete tools no index port, so the derived index's canonical producer is the
 * one owner of freshness: an edit made by a host tool is re-read into the index
 * and a deleted file leaves it, with no tool-side reindex.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-index-freshness';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const OLD_MARKER = 'freshness-original-marker-4417';
const NEW_MARKER = 'freshness-rewritten-marker-4417';
const REWRITE_PROMPT = 'Rewrite the notes file.';
const DELETE_PROMPT = 'Delete the notes file.';
const REWRITTEN = 'The notes are rewritten.';
const DELETED = 'The notes are deleted.';

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

/** Text search over the seeded root, through the visible Search & Indexing controls. */
async function enableTextIndexing(page: Page): Promise<void> {
  await new HomePage(page).openSettings();
  const section = await new SettingsPage(page).openCategory(
    /Search & Indexing/i,
    'search-indexing'
  );
  await section.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
  await page.getByRole('option', { name: /BGE Small/ }).click();
  await section.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
  await expect(section.getByRole('combobox', { name: 'Managed collection' })).toContainText(
    'Workspace Index (BGE Small)',
    { timeout: 15_000 }
  );
  await section.getByRole('combobox', { name: 'Search mode' }).click();
  await page.getByRole('option', { exact: true, name: 'Text search' }).click();
}

/** The paths of the native index's hits for `pattern` across every authorized root. */
async function indexedPathsMatching(page: Page, pattern: string): Promise<string[] | 'not-ready'> {
  return await page.evaluate(async (needle) => {
    const capability = (window as Window & { readonly indexSearch?: IndexSearchCapability })
      .indexSearch;
    if (!capability) {
      throw new Error('The native index capability is unavailable');
    }
    const status = await capability.status();
    if (
      status.kind !== 'ready' ||
      status.rootReadiness.length === 0 ||
      !status.rootReadiness.every((root) => root.scanComplete)
    ) {
      return 'not-ready';
    }
    const result = await capability.grep({
      caseSensitive: true,
      isRegex: false,
      limit: 10,
      pattern: needle,
      rootIds: status.authorizedRootIds,
    });
    return result.hits.map((hit) => hit.relativePath ?? '').sort();
  }, pattern);
}

function lastUserMessage({ messages }: ModelProviderRequest): string {
  return JSON.stringify(
    messages
      .filter(
        (message) =>
          message && typeof message === 'object' && 'role' in message && message.role === 'user'
      )
      .at(-1)
  );
}

test('a host thread’s write and delete reach the native index through its watcher', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(360_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-index-freshness-')));
  writeFileSync(path.join(root, 'notes.txt'), `first line\n${OLD_MARKER}\n`);
  try {
    await seedRoot(page, root, {
      reloadReason: 'm6-index-freshness-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    await enableTextIndexing(page);
    await expect
      .poll(async () => await indexedPathsMatching(page, OLD_MARKER), { timeout: 120_000 })
      .toEqual(['notes.txt']);

    modelProvider.setScript((request) => {
      const prompt = lastUserMessage(request);
      const toolName = (suffix: string) => request.toolNames.find((tool) => tool.endsWith(suffix));
      if (prompt.includes(REWRITE_PROMPT)) {
        const name = toolName('writeWorkspaceFile');
        return name
          ? {
              finalText: REWRITTEN,
              toolCall: {
                arguments: { content: `first line\n${NEW_MARKER}\n`, path: 'notes.txt' },
                name,
              },
            }
          : { finalText: `No write tool offered: ${request.toolNames.join(', ')}` };
      }
      if (prompt.includes(DELETE_PROMPT)) {
        // The delete tool is deferred: the shim loads it with `load_tool` first.
        return request.toolNames.includes('load_tool')
          ? {
              deferredTool: true,
              finalText: DELETED,
              toolCall: {
                arguments: { path: 'notes.txt' },
                name: 'brainstrike_deleteWorkspaceFile',
              },
            }
          : { finalText: `No load_tool offered: ${request.toolNames.join(', ')}` };
      }
      return { finalText: 'Index freshness' };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const send = async (prompt: string, reply: string): Promise<void> => {
      await region.getByRole('textbox', { name: 'Message input' }).fill(prompt);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      // The default `edit: ask` policy pauses each file mutation.
      const approve = region.getByRole('button', { name: /^Approve / });
      await expect(approve).toBeVisible({ timeout: 90_000 });
      await approve.click();
      await expect(region.getByText(reply)).toBeVisible({ timeout: 90_000 });
    };

    await send(REWRITE_PROMPT, REWRITTEN);
    // The host wrote the file; the watcher's pass re-reads it into the index.
    await expect
      .poll(async () => await indexedPathsMatching(page, NEW_MARKER), { timeout: 60_000 })
      .toEqual(['notes.txt']);
    expect(await indexedPathsMatching(page, OLD_MARKER)).toEqual([]);

    await send(DELETE_PROMPT, DELETED);
    // The deleted file leaves the index the same way.
    await expect
      .poll(async () => await indexedPathsMatching(page, NEW_MARKER), { timeout: 60_000 })
      .toEqual([]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
