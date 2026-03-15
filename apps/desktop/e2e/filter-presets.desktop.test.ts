import type { Locator, Page } from '@playwright/test';
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

async function resolvePresetTrigger(window: Page): Promise<Locator> {
  const explorerPanel = window.locator('#explorer-panel');
  const presetTrigger = explorerPanel
    .locator('button')
    .filter({ hasText: /select filter|source files|documentation|typescript\/javascript/i })
    .first();
  await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
  await expect(presetTrigger).toBeEnabled({ timeout: 10_000 });
  return presetTrigger;
}

async function selectMockRoot(window: Page): Promise<void> {
  const selectRootButton = window.getByRole('button', { name: /select root/i }).first();
  await expect(selectRootButton).toBeVisible({ timeout: 10_000 });
  await selectRootButton.click();

  await expect(window.getByRole('button', { name: /view filters/i })).toBeVisible({
    timeout: 15_000,
  });
}

async function selectDocumentationPreset(window: Page): Promise<void> {
  const selectedDocumentationTrigger = window.locator('#explorer-panel').getByRole('button', {
    name: /documentation/i,
  });
  if (await selectedDocumentationTrigger.isVisible().catch(() => false)) {
    await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
    return;
  }

  const presetTrigger = await resolvePresetTrigger(window);
  await presetTrigger.click();

  await expect(window.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });

  const documentationOption = window.getByRole('button', { name: /documentation/i }).first();
  await expect(documentationOption).toBeVisible({ timeout: 10_000 });
  await documentationOption.click();

  await expect(window.getByRole('button', { name: /documentation/i })).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
}

async function switchPreset(window: Page, currentName: RegExp, nextName: RegExp): Promise<void> {
  const presetTrigger = window.locator('#explorer-panel').getByRole('button', {
    name: currentName,
  });
  await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
  await presetTrigger.click();

  const nextOption = window.getByRole('button', { name: nextName }).first();
  await expect(nextOption).toBeVisible({ timeout: 10_000 });
  await nextOption.click();

  await expect(window.getByRole('button', { name: nextName })).toBeVisible({ timeout: 10_000 });
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
    await selectDocumentationPreset(window);
  });

  test('keeps the preset trigger enabled when view filters first appear', async ({ window }) => {
    test.setTimeout(45_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await resolvePresetTrigger(window);
  });

  test('loads presets without getting stuck on the loading state', async ({ window }) => {
    test.setTimeout(45_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    const presetTrigger = await resolvePresetTrigger(window);
    await presetTrigger.click();

    await expect(window.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });
    await expect(window.getByRole('button', { name: /documentation/i }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('keeps the selected preset after app restart', async ({ electron, window }) => {
    test.setTimeout(90_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);
    await selectDocumentationPreset(window);

    const relaunched = await electron.restart();
    const relaunchedWindow = relaunched.window;
    await mockFileSystemOperations(relaunchedWindow);
    await ensureLeftPanelVisible(relaunchedWindow);

    const viewFiltersButton = relaunchedWindow.getByRole('button', { name: /view filters/i });
    if (!(await viewFiltersButton.isVisible().catch(() => false))) {
      await selectMockRoot(relaunchedWindow);
    }

    await ensureViewFiltersExpanded(relaunchedWindow);
    await expect(relaunchedWindow.getByRole('button', { name: /documentation/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(relaunchedWindow.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
  });

  test('switches to a different preset without snapping back to the previous selection', async ({
    window,
  }) => {
    test.setTimeout(60_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);
    await selectDocumentationPreset(window);
    await switchPreset(window, /documentation/i, /typescript\/javascript/i);

    await expect(window.getByText('Documentation')).toBeHidden({ timeout: 10_000 });
    await expect(window.getByRole('button', { name: /typescript\/javascript/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});
