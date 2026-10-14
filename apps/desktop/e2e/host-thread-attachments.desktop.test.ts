import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-attachments';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const SAW_IMAGE = 'The model received the attached image.';
// A 1x1 PNG.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

test('an image attached on a host thread reaches the model and shows on the sent message', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  modelProvider.setScript((request) => ({
    finalText: JSON.stringify(request.messages).includes(`data:image/png;base64,${PIXEL_PNG}`)
      ? SAW_IMAGE
      : 'No image reached the model.',
  }));
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const chooser = page.waitForEvent('filechooser');
  await region.getByRole('button', { exact: true, name: 'Attach image' }).click();
  await (await chooser).setFiles({
    buffer: Buffer.from(PIXEL_PNG, 'base64'),
    mimeType: 'image/png',
    name: 'pixel.png',
  });
  await region.getByRole('textbox', { name: 'Message input' }).fill('What is in this image?');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();

  await expect(region.getByText(SAW_IMAGE)).toBeVisible({ timeout: 90_000 });
  // The committed user message carries the image it was sent with.
  await expect(region.getByRole('img', { name: 'pixel.png' })).toHaveAttribute(
    'src',
    `data:image/png;base64,${PIXEL_PNG}`
  );
  expect(modelProvider.refusals()).toEqual([]);
});
