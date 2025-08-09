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
    // This pattern has been proven to work in other tests
    await explorer.filterInput.fill('tsx');
    await page.waitForTimeout(300);

    // Expand all matching items
    await page.getByTestId('expand-all-button-small').click();
    await page.waitForTimeout(300);

    // Clear filter to see full tree with expanded folders
    await explorer.filterInput.fill('');
    await page.waitForTimeout(300);

    // Verify folders are expanded by checking if nested items are visible
    // Use items that are reliably near the top of the virtualized list
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('Header.tsx')).toBeVisible();

    // Step 3: Select multiple files at different levels
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const inputCheckbox = fileTree.getByRole('checkbox', { name: 'Select Input.tsx' });
    const headerCheckbox = fileTree.getByRole('checkbox', { name: 'Select Header.tsx' });
    const cardCheckbox = fileTree.getByRole('checkbox', { name: 'Select Card.tsx' });

    await buttonCheckbox.click({ force: true });
    await expect(buttonCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    await inputCheckbox.click({ force: true });
    await expect(inputCheckbox).toBeChecked();
    await expect(page.getByText('2/10')).toBeVisible();

    await headerCheckbox.click({ force: true });
    await expect(headerCheckbox).toBeChecked();
    await expect(page.getByText('3/10')).toBeVisible();

    await cardCheckbox.click({ force: true });
    await expect(cardCheckbox).toBeChecked();
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
    // Reacquire locators after potential unmount/remount from toggle
    const refreshedTree = page.getByRole('tree', { name: 'File tree' });
    const refreshedButtonCheckbox = page.getByRole('checkbox', { name: 'Select Button.tsx' });
    const refreshedInputCheckbox = page.getByRole('checkbox', { name: 'Select Input.tsx' });
    const refreshedHeaderCheckbox = page.getByRole('checkbox', { name: 'Select Header.tsx' });
    const refreshedCardCheckbox = page.getByRole('checkbox', { name: 'Select Card.tsx' });

    // Step 8: CRITICAL VERIFICATION - All state should be preserved

    // 8a. Verify root directory is still selected
    await expect(explorer.filterInput).toBeVisible();
    await expect(explorer.noDirectoryText).not.toBeVisible();

    // 8b. Verify file tree is still visible
    await expect(refreshedTree).toBeVisible();

    // 8c. Verify expanded folders are still expanded (use near-top items)
    await expect(refreshedTree.getByText('Button.tsx')).toBeVisible();
    await expect(refreshedTree.getByText('Input.tsx')).toBeVisible();
    await expect(refreshedTree.getByText('Header.tsx')).toBeVisible();

    // 8d. Verify selected files are still selected
    // Virtualization can unmount offscreen items; assert selection state via counter
    await expect(page.getByText('4/10')).toBeVisible();
    // And ensure at least one checked checkbox is visible in the viewport
    await expect(refreshedTree.getByRole('checkbox', { checked: true }).first()).toBeVisible({ timeout: 10000 });
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
      const loopTree = page.getByRole('tree', { name: 'File tree' });
      // Assert selection state remains via the counter and a visible checked checkbox
      await expect(page.getByText('4/10')).toBeVisible();
      await expect(loopTree.getByRole('checkbox', { checked: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('4/10')).toBeVisible();
    }

    // Step 10: Final interaction test - ensure we can still interact with the tree
    // Deselect one item (choose any visible checked checkbox to avoid virtualization issues)
    const anyChecked = page.getByRole('tree', { name: 'File tree' }).getByRole('checkbox', { checked: true }).first();
    await anyChecked.click({ force: true });
    await expect(page.getByRole('tree', { name: 'File tree' }).getByRole('checkbox', { checked: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('3/10')).toBeVisible();

    // Select a new file to open in tabbed editor (choose a near-top visible item)
    const headerFile = page.getByRole('button', { name: 'Header.tsx' });
    await headerFile.click();
    // Verify the file opens in a tab in the tabbed editor (look specifically in console panel)
    const panelElements = getPanelElements(page);
    const headerTab = panelElements.consolePanel.getByRole('button', { name: /Header\.tsx/ }).first();
    await expect(headerTab).toBeVisible();
  });

  test('should preserve filter state when toggling navigation panel', async ({ page }) => {
    const explorer = new FileExplorerPage(page);

    // Select root directory
    await explorer.selectRoot();
    await expect(explorer.filterInput).toBeVisible();

    // First expand folders to see nested files
    await explorer.filterInput.fill('tsx');
    await page.waitForTimeout(300);
    await page.getByTestId('expand-all-button-small').click();
    await page.waitForTimeout(300);

    // Now apply the actual filter
    await explorer.filterInput.fill('tsx -test');
    await page.waitForTimeout(300);

    // Verify filtered results
    const fileTree = explorer.fileTree;
    await expect(fileTree.getByText('Button.tsx')).toBeVisible();
    await expect(fileTree.getByText('Input.tsx')).toBeVisible();
    await expect(fileTree.getByText('App.tsx')).toBeVisible();

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

    // Expand some folders using filter pattern
    await explorer.filterInput.fill('tsx');
    await page.waitForTimeout(200);
    await page.getByTestId('expand-all-button-small').click();
    await explorer.filterInput.fill('');
    await page.waitForTimeout(200);

    // Select multiple files
    const buttonCheckbox = fileTree.getByRole('checkbox', { name: 'Select Button.tsx' });
    const headerCheckbox = fileTree.getByRole('checkbox', { name: 'Select Header.tsx' });

    await buttonCheckbox.click({ force: true });
    await headerCheckbox.click({ force: true });
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
    await expect(headerCheckbox).toBeChecked();
    await expect(page.getByText('2/10')).toBeVisible();
  });
});
