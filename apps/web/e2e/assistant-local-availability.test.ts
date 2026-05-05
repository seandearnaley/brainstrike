import { expect, test } from '@playwright/test';
import { openAssistantWorkspace } from './utils/assistant-workspace';

test.describe('Assistant local availability (web)', () => {
  test.beforeEach(async ({ page }) => {
    const tree = {
      'README.md': '# BrainStrike local assistant availability workspace',
    };

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

    await openAssistantWorkspace(page, {
      enableLocalAssistantModel: true,
      rootName: 'assistant-local-availability',
      tree,
    });
  });

  test('enables the assistant when the built-in local model is available without hosted keys', async ({
    page,
  }) => {
    const assistantViewport = page.getByTestId('assistant-ui-viewport');
    await expect(assistantViewport).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('assistant-status-callout')).toBeHidden();
  });
});
