import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { FileExplorerPage } from './page-objects/file-explorer-page';
import {
  bootstrapFileExplorer,
  type ExplorerBootstrapOptions,
  reloadExplorer,
} from './utils/file-explorer-setup';
import type { FileTree } from './utils/mock-fs';

/**
 * Helper to ensure the selection settings button is available in the current explorer state.
 */
async function openSelectionSettings(page: Page) {
  const settingsButton = page.getByRole('button', { name: /Selection settings/i });
  if (await settingsButton.isVisible().catch(() => false)) {
    return settingsButton;
  }

  const selectRootButton = page.getByRole('button', { name: /^Select Root$/i });
  if (await selectRootButton.isVisible().catch(() => false)) {
    await selectRootButton.click();
  }

  await expect(settingsButton).toBeVisible();
  return settingsButton;
}

/**
 * Helper to open the selection settings popover and set the max selection count
 */
async function setMaxSelectionCount(page: Page, value: number | string): Promise<void> {
  const settingsButton = await openSelectionSettings(page);
  await settingsButton.click();

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
  test.describe('core experience', { tag: '@smoke' }, () => {
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

    test('should show action buttons in disabled state initially', async () => {
      await expect(explorer.downloadContextButton).toBeVisible({ timeout: 10_000 });
      await expect(explorer.downloadContextButton).toBeDisabled();
      await expect(explorer.copyContextButton).toBeVisible();
      await expect(explorer.copyContextButton).toBeDisabled();
      await expect(explorer.includeProjectTreeToggle).toBeVisible();
    });

    test('should show selection counter with initial state', async ({ page }) => {
      await expect(page.getByText('0/10')).toBeVisible();
    });

    test('keeps footer controls usable when the explorer panel is narrowed', async ({ page }) => {
      await explorer.selectRoot();

      const leftPanel = page.locator('#explorer-panel');
      const initialWidth = await leftPanel.evaluate(
        (element) => element.getBoundingClientRect().width
      );

      const resizeHandle = page.locator('[data-separator]').first();
      const handleBox = await resizeHandle.boundingBox();
      if (!handleBox) {
        throw new Error('Resize handle not found');
      }

      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x - 120, handleBox.y + handleBox.height / 2);
      await page.mouse.up();

      await page.waitForTimeout(300);

      const narrowedWidth = await leftPanel.evaluate(
        (element) => element.getBoundingClientRect().width
      );
      expect(narrowedWidth).toBeLessThan(initialWidth);

      await expect(page.getByRole('button', { name: 'Selection settings' })).toBeVisible();
      await expect(page.getByTestId('selection-count')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Select All' })).toBeVisible();
      await expect(page.getByTestId('bulk-action-full-label')).not.toBeVisible();

      await page.getByRole('button', { name: 'Selection settings' }).click();
      await expect(page.getByRole('button', { name: '5K' })).toBeVisible();
      await expect(page.getByRole('button', { name: '6K' })).toBeVisible();
      await expect(page.getByRole('button', { name: '8K' })).toBeVisible();
    });

    test('shows the active root badge in the toolbar without rendering a separate current-directory row', async ({
      page,
    }) => {
      await explorer.selectRoot();

      const toolbar = page.getByTestId('file-explorer-toolbar');
      await expect(toolbar).toContainText('test-root');
      await expect(page.getByText(/current directory/i)).toHaveCount(0);
    });

    test('uses the same preview toolbar pattern across table and tapestry views', async ({
      page,
    }) => {
      await explorer.selectRoot();

      await explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' }).click({
        force: true,
      });
      await explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' }).click({
        force: true,
      });

      const previewToolbar = page.getByTestId('preview-view-toolbar');
      await expect(previewToolbar).toBeVisible();
      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
      await expect(
        previewToolbar.getByRole('button', { name: 'Toggle multi-select' })
      ).toBeVisible();
      await expect(previewToolbar.getByRole('button', { name: 'Group by' })).toBeVisible();
      await expect(
        previewToolbar.getByRole('button', { name: 'Select visible columns' })
      ).toBeVisible();

      await page.getByRole('tab', { name: 'Tapestry View' }).click();
      await expect(
        previewToolbar.getByRole('button', { name: 'Toggle multi-select' })
      ).toBeVisible();
      await expect(previewToolbar.getByRole('button', { name: 'Group by' })).toBeVisible();
      await expect(
        previewToolbar.getByRole('button', { name: 'Select visible columns' })
      ).toHaveCount(0);
      await expect(page.getByLabel('Select all files on current page')).toHaveCount(0);
    });

    test('renders the summary mode controls above the tabs without footer resize chrome', async ({
      page,
    }) => {
      await explorer.selectRoot();

      await explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' }).click({
        force: true,
      });

      const compactModeButton = page.getByRole('button', { name: 'Compact summary mode' });
      const tableTab = page.getByRole('tab', { name: 'Table View' });

      await expect(compactModeButton).toBeVisible();
      await expect(tableTab).toBeVisible();
      await expect(page.getByRole('button', { name: 'Balanced summary mode' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Insights summary mode' })).toBeVisible();
      await expect(
        page.getByRole('separator', { name: /resize context explorer footer/i })
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: /collapse footer/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /expand footer/i })).toHaveCount(0);

      const compactBox = await compactModeButton.boundingBox();
      const tableTabBox = await tableTab.boundingBox();
      expect(compactBox).not.toBeNull();
      expect(tableTabBox).not.toBeNull();
      expect((compactBox?.y ?? Number.POSITIVE_INFINITY) + (compactBox?.height ?? 0)).toBeLessThan(
        tableTabBox?.y ?? Number.NEGATIVE_INFINITY
      );
    });

    test('hides grouped selection checkboxes when selection controls are toggled off', async ({
      page,
    }) => {
      await explorer.selectRoot();

      await explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' }).click({
        force: true,
      });
      await explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' }).click({
        force: true,
      });

      const previewToolbar = page.getByTestId('preview-view-toolbar');
      await expect(previewToolbar).toBeVisible();
      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
      await previewToolbar.getByRole('button', { name: 'Group by' }).click();
      await page.getByRole('menuitemradio', { name: 'By Directory' }).click();

      const groupedSelectionCheckboxes = page.getByRole('checkbox', {
        name: /^Select all files in group /i,
      });
      await expect(groupedSelectionCheckboxes).toHaveCount(0);
      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
      await expect(groupedSelectionCheckboxes).toHaveCount(1);

      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();

      await expect(groupedSelectionCheckboxes).toHaveCount(0);
      await expect(page.getByLabel('Select all files on current page')).toHaveCount(0);
    });

    test('renders non-folder group headers in the folder column for size grouping', async ({
      page,
    }) => {
      explorer = await bootstrapFileExplorer(page, {
        resetSettings: true,
        tree: {
          'tiny.json': '{}',
          'medium.ts': `export const medium = "${'x'.repeat(1400)}";`,
        },
      });

      await explorer.selectRoot();
      await explorer.selectAllButton.click();

      const previewToolbar = page.getByTestId('preview-view-toolbar');
      await expect(previewToolbar).toBeVisible();
      await previewToolbar.getByRole('button', { name: 'Group by' }).click();
      await page.getByRole('menuitemradio', { name: 'By Size Range' }).click();

      const contextTree = page.getByRole('treegrid', { name: 'Context explorer table' });
      const groupRow = contextTree
        .getByRole('row')
        .filter({ has: page.getByRole('button', { name: 'Collapse' }) })
        .first();
      await expect(groupRow).toBeVisible();

      const folderHeader = page.getByRole('button', { name: 'Sort by Folder' });
      const pathHeader = page.getByRole('button', { name: 'Sort by File Path' });
      const spanningFolderCell = groupRow.locator('[role="gridcell"][colspan="2"]').first();
      await expect(spanningFolderCell).toContainText('Small');

      const [folderBox, pathBox, spanningCellBox] = await Promise.all([
        folderHeader.boundingBox(),
        pathHeader.boundingBox(),
        spanningFolderCell.boundingBox(),
      ]);

      if (!(folderBox && pathBox && spanningCellBox)) {
        throw new Error('Expected grouped size row geometry to be measurable');
      }

      expect(spanningCellBox.x).toBeLessThan(pathBox.x);
      expect(spanningCellBox.x).toBeLessThan(folderBox.x + folderBox.width);
    });

    test('should allow downloading context with multiple file selections', async ({ page }) => {
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

      await expect(explorer.downloadContextButton).toBeEnabled();

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        explorer.downloadContextButton.click(),
      ]);

      expect(download.suggestedFilename()).toMatch(/context/i);
    });
  });

  test.describe('filtering', { tag: '@smoke' }, () => {
    async function openViewFilters(page: Page): Promise<void> {
      const viewFiltersToggle = page.getByRole('button', { name: /view filters/i });
      await expect(viewFiltersToggle).toBeVisible({ timeout: 10_000 });

      if ((await viewFiltersToggle.getAttribute('aria-expanded')) !== 'true') {
        await viewFiltersToggle.click();
      }

      await expect(viewFiltersToggle).toHaveAttribute('aria-expanded', 'true');
    }

    async function getPresetTrigger(page: Page) {
      const presetTrigger = page
        .locator('#explorer-panel')
        .locator('button')
        .filter({ hasText: /select filter|source files|documentation|typescript\/javascript/i })
        .first();

      await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
      await expect(presetTrigger).toBeEnabled({ timeout: 10_000 });
      return presetTrigger;
    }

    interface FilterScenario {
      before?: (ctx: { page: Page; explorer: FileExplorerPage }) => Promise<void>;
      expectedHidden: string[];
      expectedVisible: string[];
      query: string;
      title: string;
    }

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

    test('keeps the preset trigger enabled when view filters first appear', async ({ page }) => {
      await openViewFilters(page);
      await getPresetTrigger(page);
    });

    test('loads presets and applies a selected preset from the dropdown', async ({ page }) => {
      await openViewFilters(page);

      const presetTrigger = await getPresetTrigger(page);
      await presetTrigger.click();

      await expect(page.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });

      const documentationOption = page.getByRole('button', { name: /documentation/i }).first();
      await expect(documentationOption).toBeVisible({ timeout: 10_000 });
      await documentationOption.click();

      await expect(
        page.locator('#explorer-panel').getByRole('button', { name: /documentation/i })
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('Select filter...')).toHaveCount(0);
    });

    test('keeps root Select All and single-click expansion aligned with the TypeScript/JavaScript preset', async ({
      page,
    }) => {
      const presetTree: FileTree = {
        src: {
          'app.ts': null,
          'readme.md': null,
          nested: {
            'deep.tsx': null,
            'notes.txt': null,
          },
        },
        scripts: {
          'build.js': null,
        },
        docs: {
          'guide.md': null,
        },
        assets: {
          'logo.png': null,
        },
      };

      const filteredExplorer = await bootstrapFileExplorer(page, {
        tree: presetTree,
        projectName: 'filtered-select-all-project',
        resetSettings: true,
        clearStorageKeys: ['panel-layout-store.v1'],
      });

      await filteredExplorer.selectRoot();
      await openViewFilters(page);

      const presetTrigger = await getPresetTrigger(page);
      await presetTrigger.click();
      await expect(page.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });

      const tsPresetOption = page.getByRole('button', { name: /typescript\/javascript/i }).first();
      await expect(tsPresetOption).toBeVisible({ timeout: 10_000 });
      await tsPresetOption.click();

      await expect(
        page.locator('#explorer-panel').getByRole('button', { name: /typescript\/javascript/i })
      ).toBeVisible({ timeout: 10_000 });

      await filteredExplorer.selectAllButton.click();

      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select src' })
      ).toHaveAttribute('data-state', 'checked');
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select scripts' })
      ).toHaveAttribute('data-state', 'checked');
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select docs' })
      ).toHaveAttribute('data-state', 'unchecked');
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select assets' })
      ).toHaveAttribute('data-state', 'unchecked');

      const srcRow = filteredExplorer.fileTree.getByRole('row', {
        name: /Expand Select src src/i,
      });
      await srcRow.getByRole('button', { name: 'Expand' }).click();

      await expect(filteredExplorer.fileTree.getByText('app.ts')).toBeVisible({ timeout: 10_000 });
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select app.ts' })
      ).toBeChecked();
      await expect(filteredExplorer.fileTree.getByText('readme.md')).not.toBeVisible();

      const nestedRow = filteredExplorer.fileTree.getByRole('row', {
        name: /Expand Select nested nested/i,
      });
      await nestedRow.getByRole('button', { name: 'Expand' }).click();

      await expect(filteredExplorer.fileTree.getByText('deep.tsx')).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select deep.tsx' })
      ).toBeChecked();
      await expect(filteredExplorer.fileTree.getByText('notes.txt')).not.toBeVisible();
    });

    test('does not stay stuck on loading presets after opening the dropdown', async ({ page }) => {
      await openViewFilters(page);

      const presetTrigger = await getPresetTrigger(page);
      await presetTrigger.click();

      await expect(page.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: /documentation/i }).first()).toBeVisible({
        timeout: 10_000,
      });
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
    interface SettingsScenario {
      execute: (ctx: { page: Page; explorer: FileExplorerPage }) => Promise<void>;
      name: string;
      options?: Partial<ExplorerBootstrapOptions>;
      tree: FileTree;
    }

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
          const settingsButton = await openSelectionSettings(page);
          await settingsButton.click();

          const input = page.getByLabel('Maximum selection count input');
          await expect(input).toBeVisible();

          await input.fill('0');
          await page.getByRole('button', { name: 'Apply selection count' }).click();

          // Should show error message
          await expect(page.getByText('Minimum selection count is 1')).toBeVisible();

          // Cancel and close popover
          await page.getByRole('button', { name: 'Close selection settings' }).click();
          await expect(input).not.toBeVisible();

          // Value should still be default (10)
          let maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('10');

          // Try to set invalid value (too high)
          await settingsButton.click();
          await expect(input).toBeVisible();

          await input.fill('50000');
          await page.getByRole('button', { name: 'Apply selection count' }).click();

          // Should show error message
          await expect(page.getByText('Maximum selection count is 10,000')).toBeVisible();

          // Cancel and close popover
          await page.getByRole('button', { name: 'Close selection settings' }).click();
          await expect(input).not.toBeVisible();

          // Value should still be 10
          maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('10');
        },
      },
      // Note: Include/Exclude filters and Use Regex toggle were moved to ViewFilterPresetDropdown
      // Persistence of filter presets is tested in view-filter-preset tests
      {
        name: 'persists Include Project Tree toggle',
        tree: {
          src: {
            'component.tsx': null,
          },
        },
        execute: async ({ page, explorer }) => {
          await expect(explorer.includeProjectTreeToggle).toBeVisible();
          await explorer.includeProjectTreeToggle.click();
          await expect(explorer.includeProjectTreeToggle).toHaveAttribute('aria-checked', 'false');

          await reloadExplorer(page);

          await expect(explorer.includeProjectTreeToggle).toBeVisible();
          await expect(explorer.includeProjectTreeToggle).toHaveAttribute('aria-checked', 'false');
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

        await scenario.execute({ page, explorer });
      });
    }
  });
});
