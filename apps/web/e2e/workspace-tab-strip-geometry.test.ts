import { expect, type Locator, type Page, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * Painted geometry of the workspace strip on the shared TabStrip (BST-1839,
 * spec §5): the pinned app group and the scroll group of file tabs share the
 * token geometry, a hairline separates them, pinned labels collapse to icons in
 * a narrow strip, and the panel's hide button no longer looks like a chevron.
 * Literal values on purpose: they are the contract, measured on the built app.
 */

interface Box {
  readonly borderRadius: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

function measure(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      borderRadius: style.borderRadius,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      width: rect.width,
    };
  });
}

/** Panel sizes are percentages: [explorer, workspace, console]. */
async function seedWorkspacePanelPercent(page: Page, workspacePercent: number): Promise<void> {
  await page.evaluate((percent) => {
    localStorage.setItem(
      'panel-layout-store.v1',
      JSON.stringify({
        state: {
          showConsole: false,
          showLeftPanel: true,
          showRightPanel: true,
          sizes: [18, percent, 20],
        },
        version: 4,
      })
    );
  }, workspacePercent);
}

async function openWorkspace(page: Page, workspacePercent: number): Promise<void> {
  const tree: FileTree = { 'alpha.ts': null, 'beta.ts': null };
  await mockBrowserApis(page, 'test-root', tree);
  await page.goto('/');
  await waitForAppLoad(page, { waitForDatabase: false });
  await resetAppState(page);
  await seedWorkspacePanelPercent(page, workspacePercent);
  await page.reload();
  await waitForAppLoad(page, { waitForDatabase: false });
}

async function openFileTabs(page: Page): Promise<void> {
  await page.getByTestId('select-root-button').click();
  const fileTree = getFileTree(page);
  await expect(fileTree).toBeVisible();
  await fileTree.getByText('alpha.ts', { exact: true }).click();
  // Opening a file shows its tab; go back to Files for the second one.
  await page.getByTestId('workspace-app-tab-context-explorer').click();
  await fileTree.getByText('beta.ts', { exact: true }).click();
  await expect(page.getByTestId('workspace-tab-scroll').getByRole('tab')).toHaveCount(2);
}

function shellOf(tab: Locator): Locator {
  return tab.locator('xpath=ancestor::*[@data-slot="tab-shell"][1]');
}

test.describe('Workspace tab strip geometry', () => {
  test.use({ viewport: { height: 1000, width: 1600 } });

  test('pinned and scroll groups paint the shared tab tokens', async ({ page }) => {
    await openWorkspace(page, 45);
    await openFileTabs(page);

    // IdeLayout's header owns the 36px row and its 1px hairline; the embedded
    // strip fills the content box above that hairline.
    const strip = page.getByTestId('workspace-tab-strip');
    const header = page.getByTestId('right-panel-header').filter({ has: strip });
    expect((await measure(header)).height).toBe(36);
    expect((await measure(strip)).height).toBe(35);

    const filesTab = page.getByTestId('workspace-app-tab-context-explorer');
    const scroller = page.getByTestId('workspace-tab-scroll');
    const alphaTab = scroller.getByRole('tab', { name: /alpha\.ts/ });
    const betaTab = scroller.getByRole('tab', { name: /beta\.ts/ });

    for (const tab of [filesTab, alphaTab, betaTab]) {
      const shell = await measure(shellOf(tab));
      expect(shell.height).toBe(28);
      expect(shell.borderRadius).toBe('6px');
      const label = await measure(tab);
      expect(label.fontSize).toBe('12px');
      expect(label.fontWeight).toBe('500');
    }

    const alpha = await measure(shellOf(alphaTab));
    const beta = await measure(shellOf(betaTab));
    expect(beta.left - alpha.right).toBe(4);

    // The active tab shows its 20px close slot.
    await expect(betaTab).toHaveAttribute('aria-selected', 'true');
    const close = await measure(shellOf(betaTab).locator('[data-slot="tab-close"]'));
    expect(close.width).toBe(20);
    expect(close.height).toBe(20);

    // A hairline separates the pinned group from the scroll group.
    // Tab shells carry data-group too; the group container is the one without a slot.
    const pinnedGroup = strip.locator('[data-group="pinned"]:not([data-slot])');
    const separator = strip.locator(
      '[data-group="pinned"]:not([data-slot]) + [aria-hidden="true"]'
    );
    await expect(separator).toHaveCount(1);
    const pinned = await measure(pinnedGroup);
    const rule = await measure(separator);
    const scroll = await measure(scroller);
    expect(rule.width).toBe(1);
    expect(rule.height).toBe(16);
    expect(rule.left).toBeGreaterThanOrEqual(pinned.right);
    expect(scroll.left).toBeGreaterThanOrEqual(rule.right);
  });

  test('pinned labels collapse to icons below a 520px strip and keep their names', async ({
    page,
  }) => {
    await openWorkspace(page, 45);
    const strip = page.getByTestId('workspace-tab-strip');
    const filesTab = page.getByRole('tab', { exact: true, name: 'Files' });
    const filesLabel = filesTab.getByText('Files', { exact: true });

    expect((await measure(strip)).width).toBeGreaterThanOrEqual(520);
    expect((await measure(filesLabel)).width).toBeGreaterThan(1);

    // Same layout, narrower window: the workspace panel keeps 45%.
    await page.setViewportSize({ height: 1000, width: 1000 });
    await expect.poll(async () => (await measure(strip)).width).toBeLessThan(520);
    await expect.poll(async () => (await measure(filesLabel)).width).toBe(1);
    await expect(filesTab).toBeVisible();
    await expect(filesTab).toHaveAccessibleName('Files');
  });

  test('the panel hide button draws a panel-close icon, not a chevron', async ({ page }) => {
    await openWorkspace(page, 45);
    const icon = page.getByTestId('hide-workspace-panel').locator('svg');
    await expect(icon).toHaveClass(/lucide-panel-right-close/);
    await expect(icon).not.toHaveClass(/lucide-chevron/);
  });
});
