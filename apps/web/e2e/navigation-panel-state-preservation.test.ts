import { expect, type Locator, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState } from './utils/app-state';
import {
  CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR,
  contextExplorerActiveNavLocator,
  waitForAppLoad,
} from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

async function checkTreeCheckbox(checkbox: Locator): Promise<void> {
  await checkbox.scrollIntoViewIfNeeded();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
}

async function uncheckTreeCheckbox(checkbox: Locator): Promise<void> {
  await checkbox.scrollIntoViewIfNeeded();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
}

test.describe('Navigation Panel State Preservation', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      src: {
        components: {
          ui: {
            'Button.tsx': null,
            'Card.tsx': null,
            'Modal.tsx': null,
          },
          forms: {
            'Input.tsx': null,
            'Select.tsx': null,
            'Checkbox.tsx': null,
          },
          'Header.tsx': null,
          'Footer.tsx': null,
        },
        hooks: {
          'useAuth.ts': null,
          'useTheme.ts': null,
        },
        utils: {
          'helpers.ts': null,
          'validators.ts': null,
        },
        'index.ts': null,
        'App.tsx': null,
      },
      tests: {
        unit: {
          'Button.test.tsx': null,
          'Input.test.tsx': null,
        },
        integration: {
          'auth.test.ts': null,
        },
      },
      'package.json': null,
      'README.md': null,
      'tsconfig.json': null,
    };

    await mockBrowserApis(page, 'test-root', tree, { clipboard: true });
    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    // Verify initial state — sidebar nav marks Context Explorer as the active page.
    await expect(contextExplorerActiveNavLocator(page)).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible();
    await expect(page.getByText('No directory selected')).toBeVisible();
  });

  test('should preserve expanded folders, selected items, and scroll position when toggling navigation panel', async ({
    page,
  }) => {
    const explorer = new FileExplorerPage(page);

    // Step 1: Select root directory
    await explorer.selectRoot();
    await expect(explorer.filterInput).toBeVisible();
    await expect(explorer.noDirectoryText).not.toBeVisible();

    const fileTree = explorer.fileTree;
    await expect(fileTree).toBeVisible();

    // Step 2: Expand nested folders using the filter + expand all pattern
    // Filter by 'tsx' to match component files
    await explorer.filterInput.fill('tsx');
    await expect(explorer.filterInput).toHaveValue('tsx');

    // Expand all matching items - this reveals nested files
    const expandAllBtn = page.getByTestId('expand-all-button-small');
    await expect(expandAllBtn).toBeVisible({ timeout: 5000 });
    await expandAllBtn.click();
    // Wait for expansion to complete - nested component files should be visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('Input.tsx')).toBeVisible({ timeout: 5000 });

    // Clear filter to see full tree with expanded folders
    await explorer.filterInput.fill('');
    await expect(explorer.filterInput).toHaveValue('');

    // Verify folders are still expanded by checking if nested items remain visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('Header.tsx')).toBeVisible();

    // Step 3: Select multiple files at different levels
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const inputCheckbox = fileTree.getByRole('checkbox', { name: 'Select Input.tsx' });
    const headerCheckbox = fileTree.getByRole('checkbox', { name: 'Select Header.tsx' });

    await checkTreeCheckbox(buttonCheckbox);
    await expect(page.getByText('1/10')).toBeVisible();

    await checkTreeCheckbox(inputCheckbox);
    await expect(page.getByText('2/10')).toBeVisible();

    await checkTreeCheckbox(headerCheckbox);
    await expect(page.getByText('3/10')).toBeVisible();

    // Step 4: Store the current state for verification
    // Get scroll position of the file tree (if scrollable)
    const fileTreeScrollTop = await fileTree.evaluate((el) => el.scrollTop);

    // Step 5: Hide the navigation panel
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
    await expect(hideExplorerButton).toBeVisible();
    await hideExplorerButton.click();

    // Verify panel is hidden
    const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
    await expect(leftPanel).not.toBeVisible();

    // Verify show button appears
    const showExplorerShim = page.locator('button[aria-label="Show explorer panel"]');
    await expect(showExplorerShim).toBeVisible();

    // Wait a moment to ensure any potential unmounting/remounting issues would occur
    await page.waitForTimeout(500);

    // Step 6: Show the panel again
    await showExplorerShim.click();

    // Verify panel is visible again
    await expect(leftPanel).toBeVisible();

    // Step 7: CRITICAL VERIFICATION - All state should be preserved

    // 7a. Verify root directory is still selected
    await expect(explorer.filterInput).toBeVisible();
    await expect(explorer.noDirectoryText).not.toBeVisible();

    // 7b. Verify file tree is still visible
    await expect(fileTree).toBeVisible();

    // 7c. Verify expanded folders are still expanded
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('Header.tsx')).toBeVisible();

    // 7d. Verify selected files are still selected
    await expect(buttonCheckbox).toBeChecked();
    await expect(inputCheckbox).toBeChecked();
    await expect(headerCheckbox).toBeChecked();
    await expect(page.getByText('3/10')).toBeVisible();

    // 7e. Verify scroll position is preserved (if applicable)
    const newScrollTop = await fileTree.evaluate((el) => el.scrollTop);
    expect(newScrollTop).toBe(fileTreeScrollTop);

    // Step 8: Test multiple hide/show cycles to ensure robustness
    for (let i = 0; i < 3; i++) {
      // Hide panel
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();
      await expect(showExplorerShim).toBeVisible();

      // Wait a bit
      await page.waitForTimeout(200);

      // Show panel
      await showExplorerShim.click();
      await expect(leftPanel).toBeVisible();

      // Verify critical state elements are still there
      await expect(fileTree.getByText('Button.tsx')).toBeVisible();
      await expect(buttonCheckbox).toBeChecked();
      await expect(page.getByText('3/10')).toBeVisible();
    }

    // Step 9: Final interaction test - ensure we can still interact with the tree
    await uncheckTreeCheckbox(headerCheckbox);
    await expect(page.getByText('2/10')).toBeVisible();
    const footerCheckbox = fileTree.getByRole('checkbox', { name: 'Select Footer.tsx' });
    await checkTreeCheckbox(footerCheckbox);
    await expect(page.getByText('3/10')).toBeVisible();
  });

  test('should preserve filter state when toggling navigation panel', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    // Select root directory
    await explorer.selectRoot();
    await expect(explorer.filterInput).toBeVisible();

    const fileTree = explorer.fileTree;

    // First expand folders to see nested files - use 'ts' to match all TypeScript files
    await explorer.filterInput.fill('ts');
    await expect(explorer.filterInput).toHaveValue('ts');

    // Expand all to reveal nested files
    const expandAllBtn = page.getByTestId('expand-all-button-small');
    await expect(expandAllBtn).toBeVisible({ timeout: 5000 });
    await expandAllBtn.click();
    // Wait for expansion - nested files should now be visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('Input.tsx')).toBeVisible({ timeout: 5000 });

    // Now apply the actual filter - use 'tsx -test' to exclude test files
    await explorer.filterInput.fill('tsx -test');
    await expect(explorer.filterInput).toHaveValue('tsx -test');
    // Button.tsx should still be visible (matches tsx, not a test file)
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 5000 });

    // Verify filtered results - these are nested tsx files that should be visible
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('Header.tsx')).toBeVisible();

    // Test files should not be visible due to -test filter
    await expect(fileTree.getByText('Button.test.tsx')).not.toBeVisible();

    // Select some filtered files
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    await checkTreeCheckbox(buttonCheckbox);

    // Hide the panel
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
    await hideExplorerButton.click();

    const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
    await expect(leftPanel).not.toBeVisible();

    // Show the panel again
    const showExplorerShim = page.locator('button[aria-label="Show explorer panel"]');
    await showExplorerShim.click();
    await expect(leftPanel).toBeVisible();

    // Verify filter is still applied
    expect(await explorer.filterInput.inputValue()).toBe('tsx -test');

    // Verify filtered view is still active
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('Button.test.tsx')).not.toBeVisible();

    // Verify selection is preserved
    await expect(buttonCheckbox).toBeChecked();
  });

  test('should handle rapid hide/show cycles without losing state', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    // Set up initial state
    await explorer.selectRoot();
    const fileTree = explorer.fileTree;

    // Expand some folders using filter pattern - use 'ts' to match all TypeScript files
    await explorer.filterInput.fill('ts');
    await expect(explorer.filterInput).toHaveValue('ts');

    // Expand all to reveal nested files
    const expandAllBtn = page.getByTestId('expand-all-button-small');
    await expect(expandAllBtn).toBeVisible({ timeout: 5000 });
    await expandAllBtn.click();
    // Wait for expansion - nested files should now be visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('Input.tsx')).toBeVisible({ timeout: 5000 });

    // Clear filter
    await explorer.filterInput.fill('');
    await expect(explorer.filterInput).toHaveValue('');

    // Select multiple files - use files that are definitely visible after expansion
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const inputCheckbox = fileTree.getByRole('checkbox', { name: 'Select Input.tsx' });

    await expect(buttonCheckbox).toBeVisible({ timeout: 5000 });
    await checkTreeCheckbox(buttonCheckbox);

    await expect(inputCheckbox).toBeVisible({ timeout: 5000 });
    await checkTreeCheckbox(inputCheckbox);

    await expect(page.getByText('2/10')).toBeVisible();

    // Get panel and button references
    const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
    const hideButton = page.locator('button[aria-label="Hide explorer panel"]');
    const showButton = page.locator('button[aria-label="Show explorer panel"]');

    // Perform rapid toggles
    for (let i = 0; i < 5; i++) {
      await hideButton.click();
      // Don't wait for animation to complete, immediately show again
      await showButton.click();
    }

    // Give it a moment to stabilize
    await page.waitForTimeout(500);

    // Verify state is still intact
    await expect(leftPanel).toBeVisible();
    await expect(fileTree).toBeVisible();
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(buttonCheckbox).toBeChecked();
    await expect(inputCheckbox).toBeChecked();
    await expect(page.getByText('2/10')).toBeVisible();
  });
});
