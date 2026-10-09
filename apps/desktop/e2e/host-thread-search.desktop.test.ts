import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-search';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const MARKER = 'host-search-marker-7731';
const REPLY = 'The search ran.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = (
      window as unknown as {
        electronAPI: { db: { query: (sql: string, params: unknown[]) => Promise<unknown> } };
      }
    ).electronAPI.db;
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

test('a host run’s content search runs in the agent host, reading only the index half from Main', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-host-search-')));
  writeFileSync(path.join(root, 'notes.txt'), `first line\n${MARKER} on disk\n`);
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-host-search-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
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

    // grep is read-only, so it ran without approval. Main refuses host-executed tools,
    // so its committed output came from the agent host.
    const tabId =
      (await page
        .getByRole('tablist', { name: 'Open assistant threads' })
        .getByRole('tab', { selected: true })
        .getAttribute('id')) ?? '';
    const threadId = tabId.replace('assistant-thread-tab-', '');
    const [run] = await readCommittedRuns(electron.getUserDataDir(), threadId);
    expect(run?.status).toBe('completed');
    expect(run?.results).toHaveLength(1);
    // The host's live ripgrep pass found the on-disk marker.
    expect(run?.results[0]?.output).toMatchObject({
      files: [expect.objectContaining({ path: 'notes.txt', source: 'live' })],
      liveEngine: 'ripgrep',
      outputMode: 'files',
    });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
