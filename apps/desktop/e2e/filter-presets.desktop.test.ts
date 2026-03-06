import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { mockFileSystemOperations } from './utils/electron-helpers';

async function ensureLeftPanelVisible(window: Page): Promise<void> {
  const leftPanel = window.locator('#explorer-panel');
  const showLeftPanelButton = window
    .getByTestId('show-explorer-panel')
    .or(window.getByRole('button', { name: /show explorer/i }));

  if (
    !(await leftPanel.isVisible().catch(() => false)) &&
    (await showLeftPanelButton.isVisible().catch(() => false))
  ) {
    await showLeftPanelButton.click();
  }

  await leftPanel.waitFor({ state: 'visible', timeout: 10_000 });
}

async function ensureViewFiltersExpanded(window: Page): Promise<void> {
  const toggleButton = window.getByRole('button', { name: /view filters/i });
  await expect(toggleButton).toBeVisible({ timeout: 10_000 });

  if ((await toggleButton.getAttribute('aria-expanded')) !== 'true') {
    await toggleButton.click();
  }

  await expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
}

async function selectMockRoot(window: Page): Promise<void> {
  const selectRootButton = window.getByRole('button', { name: /select root/i }).first();
  await expect(selectRootButton).toBeVisible({ timeout: 10_000 });
  await selectRootButton.click();

  await expect(window.getByRole('button', { name: /view filters/i })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Desktop filter presets', () => {
  test.beforeEach(async ({ window }) => {
    await mockFileSystemOperations(window);
  });

  test('updates the toolbar label when a preset is selected', async ({ window }) => {
    test.setTimeout(45_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    const presetTrigger = window.getByRole('button', { name: /select filter/i });
    await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
    await presetTrigger.click();

    const documentationOption = window.getByRole('button', { name: /documentation/i }).first();
    await expect(documentationOption).toBeVisible({ timeout: 10_000 });
    await documentationOption.click();

    await expect(window.getByRole('button', { name: /documentation/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
  });
});
