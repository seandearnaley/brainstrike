import {
  ensureFileExplorerPanelVisible,
  expandDirectoryIfNeeded,
  expect,
  expectFileSelected,
  installNestedFolderFixture,
  mockRootPath,
  test,
} from './file-explorer-selection.shared';

/**
 * The desktop path through Select All: the real provider stack, IPC file
 * system adapter, selection store, counter and tree. The checkbox rules
 * themselves (tristate promotion, capped Select All, query versus explicit
 * toggles, expand-all cancel) are component and hook tests in
 * packages/file-explorer-ui/src/__tests__.
 */
test.describe('Desktop file explorer selection', () => {
  test('unchecking a selected folder removes its files from the selection on desktop', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, mockRootPath('desktop-context-deselect'));
    await ensureFileExplorerPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = window.getByRole('button', { name: /^Select All$/iu }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByText('3 files selected', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expectFileSelected({
      fileName: 'index.ts',
      page: window,
      selected: true,
    });
    await expectFileSelected({
      fileName: 'extra.ts',
      page: window,
      selected: true,
    });
    await expectFileSelected({
      fileName: 'mock-file1.ts',
      page: window,
      selected: true,
    });

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(window.getByText('1 file selected', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expectFileSelected({
      fileName: 'mock-file1.ts',
      page: window,
      selected: true,
    });
    // The store keeps the query with `src` excluded rather than a resolved list,
    // so the excluded files are read from their own tree checkboxes.
    await expandDirectoryIfNeeded({
      directoryName: 'src',
      expectedChildText: 'index.ts',
      fileTree,
      page: window,
    });
    await expect(fileTree.getByRole('checkbox', { name: 'Select index.ts' })).not.toBeChecked();
    await expect(fileTree.getByRole('checkbox', { name: 'Select extra.ts' })).not.toBeChecked();
  });
});
