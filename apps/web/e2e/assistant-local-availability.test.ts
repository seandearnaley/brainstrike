import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

test.describe('Assistant local availability (web)', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'README.md': '# BrainStrike local assistant availability workspace',
    };

    await mockBrowserApis(page, 'test-root', tree);
    await page.addInitScript(() => {
      if (!('gpu' in navigator)) {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: {
            async requestAdapter() {
              return {
                info: {
                  vendor: 'playwright',
                  architecture: 'test',
                  device: 'mock-webgpu',
                  description: 'Mock WebGPU adapter for assistant availability tests',
                },
                limits: {
                  maxBufferSize: 1_073_741_824,
                  maxStorageBufferBindingSize: 1_073_741_824,
                },
              };
            },
          },
        });
      }
    });

    await page.route('**/api/assistant/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: false, reason: 'missing_api_key' }),
      });
    });

    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page);
    await page.getByTestId('select-root-button').click();
  });

  test('enables the assistant when the built-in local model is available without hosted keys', async ({
    page,
  }) => {
    const assistantViewport = page.getByTestId('assistant-ui-viewport');
    await expect(assistantViewport).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('assistant-status-callout')).toBeHidden();
  });
});
