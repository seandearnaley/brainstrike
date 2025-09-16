import { expect, test } from '@playwright/test';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

// Assistant-UI E2E (web): forces Assistant UI mode by injecting `window.assistant`
// Then exercises a simple tool call (web.echo) and checks for streaming + progress.

test.describe('Assistant UI panel (web, assistant-ui mode)', () => {
  test.beforeEach(async ({ page }) => {
    // Force Assistant UI path without changing build flags
    await page.addInitScript(() => {
      // @ts-expect-error expose minimal object to gate AssistantUiPanel render path
      window.assistant = {};
    });

    await page.goto('/');
    await waitForAppLoad(page);
  });

  test('send message and see assistant stream with tool progress', async ({ page }) => {
    // Ensure right panel is visible
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    // Assistant UI viewport should be present (assistant-ui path)
    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    // Send an echo message (triggers web.echo tool in server adapter)
    await page.locator('#assistant-input').fill('echo hello from web');
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await sendBtn.click();

    // Expect assistant to stream content
    await expect(viewport.getByText('Assistant:').first()).toBeVisible({ timeout: 10_000 });

    // Expect some indication of progress appended into tool args (starting/echoing/finishing)
    // The exact structure is assistant-ui controlled, so match by text in the viewport.
    await expect(viewport.getByText(/starting/i)).toBeVisible({ timeout: 10_000 });
    await expect(viewport.getByText(/echoing/i)).toBeVisible({ timeout: 10_000 });
    await expect(viewport.getByText(/finishing/i)).toBeVisible({ timeout: 10_000 });
  });
});
