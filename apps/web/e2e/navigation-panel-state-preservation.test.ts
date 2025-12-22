import { expect, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState } from './utils/app-state';
import { getPanelElements, togglePanelVisibility, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

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
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);

    // Verify initial state
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();
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

    // Step 2: Expand multiple nested folders using the filter + expand all pattern
    // Filter by 'ts' to match both .ts and .tsx files (including utils/helpers.ts)
    await explorer.filterInput.fill('ts');
    // Wait for filter to be applied (look for a matching file)
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 5000 });

    // Expand all matching items
    await page.getByTestId('expand-all-button-small').click();
    // Wait for expansion to complete
    await expect(fileTree.getByText('helpers.ts')).toBeVisible({ timeout: 5000 });

    // Clear filter to see full tree with expanded folders
    await explorer.filterInput.fill('');
    // Wait for filter to clear - package.json should now be visible
    await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 5000 });

    // Verify folders are expanded by checking if nested items are visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('Header.tsx')).toBeVisible();
    await expect(fileTree.getByText('helpers.ts')).toBeVisible();

    // Step 3: Select multiple files at different levels
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const inputCheckbox = fileTree.getByRole('checkbox', { name: 'Select Input.tsx' });
    const helpersCheckbox = fileTree.getByRole('checkbox', { name: 'Select helpers.ts' });
    const packageCheckbox = fileTree.getByRole('checkbox', { name: 'Select package.json' });

    await buttonCheckbox.click({ force: true });
    await expect(buttonCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    await inputCheckbox.click({ force: true });
    await expect(inputCheckbox).toBeChecked();
    await expect(page.getByText('2/10')).toBeVisible();

    await helpersCheckbox.click({ force: true });
    await expect(helpersCheckbox).toBeChecked();
    await expect(page.getByText('3/10')).toBeVisible();

    await packageCheckbox.click({ force: true });
    await expect(packageCheckbox).toBeChecked();
    await expect(page.getByText('4/10')).toBeVisible();

    // Step 4: Show console panel and click on a file to open it in tabbed editor
    const elements = getPanelElements(page);
    await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);

    const buttonFile = page.getByRole('button', { name: 'Button.tsx' });
    await buttonFile.click();
    // File should open in a tab in the tabbed file editor (look specifically in console panel)
    const tab = elements.consolePanel.getByRole('button', { name: /Button\.tsx/ }).first();
    await expect(tab).toBeVisible();

    // Step 5: Store the current state for verification
    // Get scroll position of the file tree (if scrollable)
    const fileTreeScrollTop = await fileTree.evaluate((el) => el.scrollTop);

    // Step 6: Hide the navigation panel
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
    await expect(hideExplorerButton).toBeVisible();
    await hideExplorerButton.click();

    // Verify panel is hidden
    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    await expect(leftPanel).not.toBeVisible();

    // Verify show button appears
    const showExplorerShim = page.locator('button[aria-label="Show explorer"]');
    await expect(showExplorerShim).toBeVisible();

    // Wait a moment to ensure any potential unmounting/remounting issues would occur
    await page.waitForTimeout(500);

    // Step 7: Show the panel again
    await showExplorerShim.click();

    // Verify panel is visible again
    await expect(leftPanel).toBeVisible();

    // Step 8: CRITICAL VERIFICATION - All state should be preserved

    // 8a. Verify root directory is still selected
    await expect(explorer.filterInput).toBeVisible();
    await expect(explorer.noDirectoryText).not.toBeVisible();

    // 8b. Verify file tree is still visible
    await expect(fileTree).toBeVisible();

    // 8c. Verify expanded folders are still expanded
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('helpers.ts')).toBeVisible();
    await expect(fileTree.getByText('Header.tsx')).toBeVisible();

    // 8d. Verify selected files are still selected
    await expect(buttonCheckbox).toBeChecked();
    await expect(inputCheckbox).toBeChecked();
    await expect(helpersCheckbox).toBeChecked();
    await expect(packageCheckbox).toBeChecked();
    await expect(page.getByText('4/10')).toBeVisible();

    // 8e. Verify tab still shows the selected file
    await expect(tab).toBeVisible();

    // 8f. Verify scroll position is preserved (if applicable)
    const newScrollTop = await fileTree.evaluate((el) => el.scrollTop);
    expect(newScrollTop).toBe(fileTreeScrollTop);

    // Step 9: Test multiple hide/show cycles to ensure robustness
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
      await expect(page.getByText('4/10')).toBeVisible();
    }

    // Step 10: Final interaction test - ensure we can still interact with the tree
    // Deselect one item
    await packageCheckbox.click({ force: true });
    await expect(packageCheckbox).not.toBeChecked();
    await expect(page.getByText('3/10')).toBeVisible();

    // Select a new file to open in tabbed editor
    const inputFile = page.getByRole('button', { name: 'Input.tsx' });
    await inputFile.click();
    // Verify the file opens in a tab in the tabbed editor (look specifically in console panel)
    const panelElements = getPanelElements(page);
    const inputTab = panelElements.consolePanel.getByRole('button', { name: /Input\.tsx/ }).first();
    await expect(inputTab).toBeVisible();
  });

  test('should preserve filter state when toggling navigation panel', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    // Select root directory
    await explorer.selectRoot();
    await expect(explorer.filterInput).toBeVisible();

    const fileTree = explorer.fileTree;

    // First expand folders to see nested files - use 'ts' to match all TypeScript files
    await explorer.filterInput.fill('ts');
    // Wait for filter to apply
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('expand-all-button-small').click();
    // Wait for expansion
    await expect(fileTree.getByText('Input.tsx')).toBeVisible({ timeout: 5000 });

    // Now apply the actual filter - use 'tsx -test' to exclude test files
    await explorer.filterInput.fill('tsx -test');
    // Wait for filter to apply - Button.tsx should still be visible
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 5000 });

    // Verify filtered results - these are nested tsx files that should be visible
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('Header.tsx')).toBeVisible();

    // Test files should not be visible due to -test filter
    await expect(fileTree.getByText('Button.test.tsx')).not.toBeVisible();

    // Select some filtered files
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    await buttonCheckbox.click({ force: true });
    await expect(buttonCheckbox).toBeChecked();

    // Hide the panel
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
    await hideExplorerButton.click();

    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    await expect(leftPanel).not.toBeVisible();

    // Show the panel again
    const showExplorerShim = page.locator('button[aria-label="Show explorer"]');
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
    // Wait for filter to apply
    await expect(fileTree.getByText('Button.tsx')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('expand-all-button-small').click();
    // Wait for expansion - check for a nested file
    await expect(fileTree.getByText('Input.tsx')).toBeVisible({ timeout: 5000 });

    // Clear filter
    await explorer.filterInput.fill('');
    // Wait for filter to clear - package.json should now be visible
    await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 5000 });

    // Select multiple files - use files that are definitely visible after expansion
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const inputCheckbox = fileTree.getByRole('checkbox', { name: 'Select Input.tsx' });

    await expect(buttonCheckbox).toBeVisible({ timeout: 5000 });
    await buttonCheckbox.click({ force: true });
    await expect(buttonCheckbox).toBeChecked();

    await expect(inputCheckbox).toBeVisible({ timeout: 5000 });
    await inputCheckbox.click({ force: true });
    await expect(inputCheckbox).toBeChecked();

    await expect(page.getByText('2/10')).toBeVisible();

    // Get panel and button references
    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    const hideButton = page.locator('button[aria-label="Hide explorer"]');
    const showButton = page.locator('button[aria-label="Show explorer"]');

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
