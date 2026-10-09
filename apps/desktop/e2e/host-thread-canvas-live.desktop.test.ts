import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderScript } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-canvas-live';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const FIRST_REPLY = 'Ready to draw.';
const SECOND_REPLY = 'The canvas is drawn.';
const CANVAS_TITLE = 'Live canvas';
const CANVAS_HTML = '<h1>Live canvas</h1><p>Drawn during the run.</p>';

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

test('an open Canvas panel shows the canvas a host run commits, without a thread switch', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-canvas-live-')));
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-canvas-live-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    let drawing = false;
    modelProvider.setScript((request): ModelProviderScript => {
      // The run streams; the host's title request does not.
      if ((request.requestBody as { stream?: unknown }).stream !== true) {
        return { finalText: 'Canvas thread' };
      }
      if (!drawing) {
        return { finalText: FIRST_REPLY };
      }
      const canvas = request.toolNames.find((tool) => tool.endsWith('manageCanvas'));
      return canvas
        ? {
            finalText: SECOND_REPLY,
            toolCall: {
              arguments: { action: 'create', html: CANVAS_HTML, title: CANVAS_TITLE },
              name: canvas,
            },
          }
        : { finalText: `Missing manageCanvas: ${request.toolNames.join(', ')}` };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const input = region.getByRole('textbox', { name: 'Message input' });
    await input.fill('Get ready.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(region.getByText(FIRST_REPLY)).toBeVisible({ timeout: 90_000 });

    // Open the Canvas panel on this thread before any canvas exists.
    await page.getByTestId('workspace-add-tab').click();
    await page.getByTestId('workspace-add-tab-canvas').click();
    const panel = page.getByTestId('canvas-panel');
    await expect(panel).toContainText('No canvases in this thread yet', { timeout: 30_000 });

    drawing = true;
    await input.fill('Draw it.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    // The canvas write pauses under the default `edit: ask`.
    const approve = region.getByRole('button', { name: /^Approve / });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    await approve.click();
    await expect(region.getByText(SECOND_REPLY)).toBeVisible({ timeout: 90_000 });

    // The open panel re-read the thread's committed canvases on its own.
    await expect(panel.getByText(CANVAS_TITLE, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId('canvas-version-label')).toHaveText('v1 / 1');
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
