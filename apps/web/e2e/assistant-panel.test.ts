import { expect, test } from '@playwright/test';
import { mockAssistantApi } from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';

test.describe('Assistant panel (assistant-ui default) @stateful', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ request }, testInfo) => {
    const response = await request.get('/api/assistant/status');
    const payload = (await response.json()) as { enabled?: boolean };
    if (!payload.enabled) {
      testInfo.skip(true, 'Assistant disabled (missing API key)');
    }
  });

  test.beforeEach(async ({ page }) => {
    await mockAssistantApi(page);
    await openAssistantWorkspace(page, { rootName: 'assistant-panel' });
  });

  test('send message and stream response while switching agent sidebar tabs', async ({ page }) => {
    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    await page.locator('#assistant-input').fill('hello world');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const databaseTab = page.getByRole('tab', { name: 'Database' });
    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    const threadsTab = page.getByRole('tab', { name: 'Threads' });
    await threadsTab.click();
    await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 15_000 });

    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
