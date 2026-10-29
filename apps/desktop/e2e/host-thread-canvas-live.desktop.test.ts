import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
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
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

test('a canvas a host run commits opens in its own tab and is saved to Artifacts', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-canvas-live-')));
  electron.removeAfterClose(root);
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
    // Hosted discovery defers manageCanvas: the model loads it, then calls it.
    return request.toolNames.includes('load_tool')
      ? {
          deferredTool: true,
          finalText: SECOND_REPLY,
          toolCall: {
            arguments: { action: 'create', html: CANVAS_HTML, title: CANVAS_TITLE },
            name: 'brainstrike_manageCanvas',
          },
        }
      : { finalText: `Missing load_tool: ${request.toolNames.join(', ')}` };
  });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await input.fill('Get ready.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(FIRST_REPLY)).toBeVisible({ timeout: 90_000 });

  await expect(page.getByTestId('canvas-document')).toHaveCount(0);

  drawing = true;
  await input.fill('Draw it.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  // The canvas write pauses under the default `edit: ask`.
  const approve = region.getByRole('button', { name: /^Approve /u });
  await expect(approve).toBeVisible({ timeout: 90_000 });
  await approve.click();
  await expect(region.getByText(SECOND_REPLY)).toBeVisible({ timeout: 90_000 });

  // The committed canvas opened in a workspace tab of its own, named after it.
  const canvasTab = page.getByRole('tab', { name: CANVAS_TITLE });
  await expect(canvasTab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  const canvas = page.getByTestId('canvas-document');
  await expect(canvas.getByTestId('canvas-title')).toHaveText(CANVAS_TITLE);
  await expect(canvas.getByTestId('canvas-version-label')).toHaveText('v1 / 1');

  // The Artifacts page lists it, and opening it from there selects its tab again.
  await page.getByRole('tab', { name: /^Files/u }).click();
  await page
    .getByRole('navigation', { exact: true, name: 'Main navigation' })
    .getByRole('button', { exact: true, name: 'Artifacts' })
    .click();
  const gallery = page.getByTestId('artifacts-grid');
  await expect(gallery.getByTestId('artifact-card')).toHaveCount(1, { timeout: 30_000 });
  await gallery.getByRole('button', { name: new RegExp(`^${CANVAS_TITLE}`, 'u') }).click();
  await expect(canvasTab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  await expect(canvas.getByTestId('canvas-version-label')).toHaveText('v1 / 1');
  expect(modelProvider.refusals()).toEqual([]);
});
