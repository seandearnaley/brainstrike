import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { FileExplorerPage } from './page-objects/file-explorer-page';
import {
  bootstrapFileExplorer,
  type ExplorerBootstrapOptions,
  openExplorerSettings,
  reloadExplorer,
} from './utils/file-explorer-setup';
import type { FileTree } from './utils/mock-fs';

/**
 * Helper to open the selection counter popover and set the max selection count
 */
async function setMaxSelectionCount(page: Page, value: number | string): Promise<void> {
  // Click the selection counter button to open the popover
  const counterButton = page.getByRole('button', {
    name: /Click to edit maximum selection count/i,
  });
  await counterButton.click();

  // Wait for popover to be visible
  const input = page.getByLabel('Maximum selection count input');
  await expect(input).toBeVisible();

  // Fill in the value
  await input.fill(String(value));

  // Click the apply button (checkmark)
  await page.getByRole('button', { name: 'Apply selection count' }).click();

  // Wait for popover to close
  await expect(input).not.toBeVisible();
}

/**
 * Helper to get the current max selection count from the selection counter
 */
async function getMaxSelectionCount(page: Page): Promise<string> {
  const text = await page.getByTestId('selection-max').textContent();
  return text || '';
}

test.describe('File Explorer', () => {
  test.describe('core experience', () => {
    let explorer: FileExplorerPage;

    const defaultTree: FileTree = {
      'test.ts': null,
      'test2.ts': null,
      folder1: {
        'nested.txt': null,
      },
    };

    test.beforeEach(async ({ page }) => {
      explorer = await bootstrapFileExplorer(page, { tree: defaultTree });
    });

    test('should show initial empty state', async ({ page }) => {
      await expect(explorer.noDirectoryText).toBeVisible();
      await expect(explorer.selectRootButton).toBeVisible();
      await expect(explorer.noFilesText).toBeVisible();
      await expect(explorer.filterInput).not.toBeVisible();
      await expect(page.getByText('No directory selected')).toBeVisible();
      await expect(page.getByText('No files selected')).toBeVisible();
    });

    test('should show workspace settings options', async ({ page }) => {
      const dialog = await openExplorerSettings(page, explorer);

      await expect(dialog.getByRole('heading', { name: 'Workspace Settings' })).toBeVisible();
      // Note: Max Selection Count was moved to SelectionCounter component
      // Note: Folder Summary Threshold was moved to Preview Panel footer
      await expect(dialog.getByPlaceholder('e.g. *.ts, src/**/*.js')).toBeVisible();
      await expect(dialog.getByPlaceholder('e.g. *.test.js, node_modules/**')).toBeVisible();
      await expect(dialog.getByRole('switch', { name: 'Use Regex' })).toBeVisible();
    });

    test('should show action buttons in disabled state initially', async () => {
      await expect(explorer.downloadReportButton).toBeVisible({ timeout: 10_000 });
      await expect(explorer.downloadReportButton).toBeDisabled();
      await expect(explorer.copyReportButton).toBeVisible();
      await expect(explorer.copyReportButton).toBeDisabled();
      await expect(explorer.includeProjectTreeToggle).toBeVisible();
    });

    test('should show selection counter with initial state', async ({ page }) => {
      await expect(page.getByText('0/10')).toBeVisible();
    });

    test('should allow downloading a report with multiple file selections', async ({ page }) => {
      await explorer.selectRoot();

      await expect(explorer.filterInput).toBeVisible({ timeout: 10_000 });
      await expect(explorer.noDirectoryText).not.toBeVisible();

      const file1Checkbox = explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' });
      const file2Checkbox = explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' });

      await expect(file1Checkbox).toBeVisible();
      await file1Checkbox.click({ force: true });
      await expect(file1Checkbox).toBeChecked();

      await expect(file2Checkbox).toBeVisible();
      await file2Checkbox.click({ force: true });
      await expect(file2Checkbox).toBeChecked();

      await expect(page.getByText('2/10')).toBeVisible();

      await expect(explorer.downloadReportButton).toBeEnabled();

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        explorer.downloadReportButton.click(),
      ]);

      expect(download.suggestedFilename()).toMatch(/report/i);
    });
  });

  test.describe('filtering', () => {
    type FilterScenario = {
      title: string;
      query: string;
      expectedVisible: string[];
      expectedHidden: string[];
      before?: (ctx: { page: Page; explorer: FileExplorerPage }) => Promise<void>;
    };

    const tree: FileTree = {
      'Button.tsx': null,
      'Button.test.tsx': null,
      'utils.ts': null,
      'utils.test.ts': null,
      'config.json': null,
      'package.json': null,
      'legacy.js': null,
      'OldComponent.jsx': null,
      my_custom_modules: {
        'some-package': {
          'index.js': null,
        },
      },
      my_custom_coverage: {
        'lcov.info': null,
      },
    };

    const bootstrapOptions: ExplorerBootstrapOptions = {
      tree,
      projectName: 'test-project',
      resetSettings: true,
      clearStorageKeys: ['panel-layout-store.v1'],
    };

    let explorer: FileExplorerPage;

    test.beforeEach(async ({ page }) => {
      explorer = await bootstrapFileExplorer(page, bootstrapOptions);

      await expect(page.getByText('No directory selected')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('No files selected')).toBeVisible({ timeout: 15_000 });

      await explorer.selectRoot();

      await expect(explorer.filterInput).toBeVisible({ timeout: 10_000 });
      await expect(explorer.noDirectoryText).not.toBeVisible();
      await expect(explorer.fileTree).toBeVisible();
    });

    const scenarios: FilterScenario[] = [
      {
        title: 'matches files by substring',
        query: 'Button',
        expectedVisible: ['Button.tsx', 'Button.test.tsx'],
        expectedHidden: ['utils.ts', 'package.json'],
      },
      {
        title: 'filters down to test files',
        query: '.test',
        expectedVisible: ['Button.test.tsx', 'utils.test.ts'],
        expectedHidden: ['Button.tsx', 'utils.ts'],
      },
      {
        title: 'supports negation syntax',
        query: 'utils -test',
        expectedVisible: ['utils.ts'],
        expectedHidden: ['utils.test.ts', 'Button.tsx'],
      },
      {
        title: 'clearing the filter restores the tree',
        query: '',
        expectedVisible: ['Button.tsx', 'utils.ts'],
        expectedHidden: [],
        before: async ({ explorer }) => {
          await explorer.filterInput.fill('Button');
          await expect(explorer.fileTree.getByText('Button.tsx')).toBeVisible();
          await expect(explorer.fileTree.getByText('utils.ts')).not.toBeVisible();
        },
      },
    ];

    for (const scenario of scenarios) {
      test(scenario.title, async ({ page }) => {
        if (scenario.before) {
          await scenario.before({ page, explorer });
        }

        await explorer.filterInput.fill(scenario.query);

        for (const fileName of scenario.expectedVisible) {
          await expect(explorer.fileTree.getByText(fileName)).toBeVisible();
        }

        for (const fileName of scenario.expectedHidden) {
          await expect(explorer.fileTree.getByText(fileName)).not.toBeVisible();
        }
      });
    }
  });

  test.describe('settings persistence', () => {
    type SettingsScenario = {
      name: string;
      tree: FileTree;
      options?: Partial<ExplorerBootstrapOptions>;
      execute: (ctx: {
        page: Page;
        explorer: FileExplorerPage;
        openDialog: () => Promise<Locator>;
      }) => Promise<void>;
    };

    const settingsScenarios: SettingsScenario[] = [
      {
        name: 'persists updates to max selection count',
        tree: { 'example.ts': null },
        execute: async ({ page }) => {
          await setMaxSelectionCount(page, 5);

          await reloadExplorer(page);

          const maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('5');
        },
      },
      {
        name: 'validates Max Selection Count values',
        tree: { 'a.ts': null, 'b.ts': null },
        execute: async ({ page }) => {
          // Try to set invalid value (too low)
          const counterButton = page.getByRole('button', {
            name: /Click to edit maximum selection count/i,
          });
          await counterButton.click();

          const input = page.getByLabel('Maximum selection count input');
          await expect(input).toBeVisible();

          await input.fill('0');
          await page.getByRole('button', { name: 'Apply selection count' }).click();

          // Should show error message
          await expect(page.getByText('Minimum selection count is 1')).toBeVisible();

          // Cancel and close popover
          await page.getByRole('button', { name: 'Cancel' }).click();
          await expect(input).not.toBeVisible();

          // Value should still be default (10)
          let maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('10');

          // Try to set invalid value (too high)
          await counterButton.click();
          await expect(input).toBeVisible();

          await input.fill('50000');
          await page.getByRole('button', { name: 'Apply selection count' }).click();

          // Should show error message
          await expect(page.getByText('Maximum selection count is 10,000')).toBeVisible();

          // Cancel and close popover
          await page.getByRole('button', { name: 'Cancel' }).click();
          await expect(input).not.toBeVisible();

          // Value should still be 10
          maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('10');
        },
      },
      {
        name: 'persists include/exclude filters',
        tree: {
          src: {
            'a.ts': null,
          },
        },
        execute: async ({ page, openDialog }) => {
          const dialog = await openDialog();
          await dialog.getByLabel('Files to Include:').fill('*.foo, lib/**');
          await dialog.getByLabel('Files to Exclude:').fill('node_modules/**, *.test.ts');
          await dialog.getByRole('button', { name: 'Apply Settings' }).click();
          await expect(dialog).not.toBeVisible();

          await reloadExplorer(page);

          const reopened = await openDialog();
          await expect(reopened.getByLabel('Files to Include:')).toHaveValue('*.foo, lib/**');
          await expect(reopened.getByLabel('Files to Exclude:')).toHaveValue(
            'node_modules/**, *.test.ts'
          );
          // Note: Folder Summary Threshold persistence is tested in report-folder-summary.test.ts
        },
      },
      {
        name: 'persists Use Regex and Include Project Tree toggles',
        tree: {
          src: {
            'component.tsx': null,
          },
        },
        execute: async ({ page, explorer, openDialog }) => {
          await expect(explorer.includeProjectTreeToggle).toBeVisible();
          await explorer.includeProjectTreeToggle.click();
          await expect(explorer.includeProjectTreeToggle).toHaveAttribute('aria-checked', 'false');

          const dialog = await openDialog();
          await dialog.getByLabel(/Use Regex/i).click();
          await dialog.getByRole('button', { name: 'Apply Settings' }).click();
          await expect(dialog).not.toBeVisible();

          await reloadExplorer(page);

          await expect(explorer.includeProjectTreeToggle).toBeVisible();
          await expect(explorer.includeProjectTreeToggle).toHaveAttribute('aria-checked', 'false');

          const reopened = await openDialog();
          await expect(reopened.getByLabel(/Use Regex/i)).toHaveAttribute('aria-checked', 'true');
        },
      },
      {
        name: 'caps selections when Max Selection Count is reduced',
        tree: { 'a.ts': null, 'b.ts': null },
        execute: async ({ explorer, page }) => {
          await setMaxSelectionCount(page, 1);

          await explorer.selectRoot();

          const fileTree = explorer.fileTree;
          const first = fileTree.getByRole('checkbox', { name: 'Select a.ts' });
          const second = fileTree.getByRole('checkbox', { name: 'Select b.ts' });

          await first.click({ force: true });
          await second.click({ force: true });

          await expect(page.getByText('1/1')).toBeVisible();
        },
      },
    ];

    for (const scenario of settingsScenarios) {
      test(scenario.name, async ({ page }) => {
        const options: ExplorerBootstrapOptions = {
          tree: scenario.tree,
          resetSettings: true,
          ...(scenario.options ?? {}),
        };

        const explorer = await bootstrapFileExplorer(page, options);
        const openDialog = () => openExplorerSettings(page, explorer);

        await scenario.execute({ page, explorer, openDialog });
      });
    }
  });
});
