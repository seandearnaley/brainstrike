import { expect, test } from '@playwright/test';

test('initializes the production WebGPU scene on a capable Chromium runtime', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');

  const capability = await page.evaluate(async () => ({
    adapter: navigator.gpu ? Boolean(await navigator.gpu.requestAdapter()) : false,
    gpu: Boolean(navigator.gpu),
  }));
  expect(capability).toEqual({ adapter: true, gpu: true });

  const visualSystem = page.getByTestId('visual-system');
  await expect(visualSystem).toHaveAttribute('data-webgpu-status', 'ready');
  await expect(page.locator('.signal-canvas')).toBeVisible();
  await expect(page.getByText('WebGPU could not initialize.')).toBeHidden();
});
