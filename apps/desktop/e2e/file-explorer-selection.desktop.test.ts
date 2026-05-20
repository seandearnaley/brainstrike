import {
  clickFileTreeCheckboxAndWaitForSelection,
  ensureLeftPanelVisible,
  expandNextDirectoryIfNeeded,
  expect,
  expectContextExplorerFileVisibility,
  FILE_EXPLORER_CLICK_TIMEOUT_MS,
  FILE_TREE_MULTI_STEP_SELECTION_TEST_TIMEOUT_MS,
  getContextExplorerMiddlePanel,
  getExpandedDirectoryCount,
  installIncrementalFolderSelectionFixture,
  installMixedHookSelectionFixture,
  installNestedFolderFixture,
  installNestedPackagesFixture,
  installWideExpandAllFixture,
  setFileExplorerMaxSelectionCount,
  test,
  waitForFileExplorerSelectionIdle,
} from './file-explorer-selection.shared';

test.describe('Desktop file explorer selection', () => {
  test('root Select All marks visible folders checked when recursive descendants are selected', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-full');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('mock-file1.ts')).toBeVisible({ timeout: 15_000 });

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    const rootFileCheckbox = fileTree.getByRole('checkbox', { name: 'Select mock-file1.ts' });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(rootFileCheckbox).not.toBeChecked();

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(rootFileCheckbox).toBeChecked();
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
  });

  test('expand all progressively reveals directories and leaves a valid tree after cancel or completion', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(60_000);

    await installWideExpandAllFixture(electronApp.app, '/mock/desktop-expand-all-progressive');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByRole('treegrid', { name: 'File tree' })).toBeVisible({
      timeout: 15_000,
    });
    const initialExpandedCount = await getExpandedDirectoryCount(window);
    const expandAllButton = window.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
    await expandAllButton.click({ noWaitAfter: true, timeout: 5000 });

    const cancelButton = window.getByRole('button', { name: 'Cancel operation' });
    await expect(cancelButton).toBeVisible({ timeout: 15_000 });
    await window.waitForFunction((previousExpandedCount) => {
      const testWindow = (
        globalThis as typeof globalThis & {
          window?: Window & {
            __brainstrike_file_explorer_provider_store__?: {
              getState?: () => { expandedDirectoryPaths?: Set<string> };
            };
          };
        }
      ).window;
      const expandedDirectoryCount =
        testWindow?.__brainstrike_file_explorer_provider_store__?.getState?.()
          .expandedDirectoryPaths?.size ?? 0;
      return expandedDirectoryCount > previousExpandedCount;
    }, initialExpandedCount);
    await expect(expandAllButton).toBeDisabled();

    await cancelButton.click({ noWaitAfter: true, timeout: 5000 }).catch(async (error: unknown) => {
      const operationStillRunning = await window
        .getByTestId('inline-scanning-indicator')
        .isVisible()
        .catch(() => false);
      if (operationStillRunning) {
        throw error;
      }
    });

    await expect(window.getByTestId('inline-scanning-indicator')).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(expandAllButton).toBeEnabled();
    expect(await getExpandedDirectoryCount(window)).toBeGreaterThan(initialExpandedCount);
  });

  test('unchecking a selected folder removes its files from the context explorer on desktop', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-context-deselect');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    const contextExplorerSurface = getContextExplorerMiddlePanel(window);
    await expect(contextExplorerSurface).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText('3 files', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expectContextExplorerFileVisibility({
      fileName: 'index.ts',
      page: window,
      visible: true,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'extra.ts',
      page: window,
      visible: true,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'mock-file1.ts',
      page: window,
      visible: true,
    });

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(window.getByText('1 files', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expectContextExplorerFileVisibility({
      fileName: 'mock-file1.ts',
      page: window,
      visible: true,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'index.ts',
      page: window,
      visible: false,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'extra.ts',
      page: window,
      visible: false,
    });
  });

  test('root capped Select All marks visible folders indeterminate when only some descendants are selected', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-capped');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('mock-file1.ts')).toBeVisible({ timeout: 15_000 });

    await setFileExplorerMaxSelectionCount(window, 2);

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    const rootFileCheckbox = fileTree.getByRole('checkbox', { name: 'Select mock-file1.ts' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(rootFileCheckbox).not.toBeChecked();

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(rootFileCheckbox).toBeChecked();
    await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
  });

  test('selection limit toast auto-dismisses and does not leave the desktop explorer unusable', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-limit-toast');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 2);

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    const limitToast = window
      .getByText('Cannot select more files. Maximum selection limit reached.', { exact: true })
      .first();
    await expect(limitToast).toBeVisible({ timeout: 15_000 });
    await expect(limitToast).not.toBeVisible({ timeout: 10_000 });

    const deselectAllButton = window.getByRole('button', { name: /^Deselect All$/i }).first();
    await expect(deselectAllButton).toBeEnabled({ timeout: 15_000 });
    await deselectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(
      fileTree.getByRole('checkbox', { name: 'Select mock-file1.ts' })
    ).not.toBeChecked();
    await expect(fileTree.getByRole('checkbox', { name: 'Select src' })).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  test('root Select All keeps expanded folders fully checked when all descendants are selected', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedPackagesFixture(electronApp.app, '/mock/desktop-selection-root-packages');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('packages')).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const packagesCheckbox = fileTree.getByRole('checkbox', { name: 'Select packages' });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'unchecked');

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'checked');

    const expandAllButton = window.getByRole('button', { name: /^Expand All$/i }).first();
    await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
    await expandAllButton.click({ noWaitAfter: true, timeout: 10_000 });

    await expect(fileTree.getByText('agent')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('app-shell')).toBeVisible({ timeout: 15_000 });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(fileTree.getByRole('checkbox', { name: 'Select agent' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    await expect(fileTree.getByRole('checkbox', { name: 'Select app-shell' })).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  test('clicking a checked query-selected folder checkbox deselects it instead of re-running recursive selection', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-toggle';
    await installMixedHookSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });
    await waitForFileExplorerSelectionIdle({
      expectedSelectedCount: 5,
      page: window,
    });

    const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

    await expandNextDirectoryIfNeeded({
      directoryName: 'hooks',
      directoryPath: `${rootPath}/hooks`,
      expectedChildText: 'src',
      fileTree,
    });
    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('tsconfig.json')).toBeVisible({ timeout: 15_000 });

    await expandNextDirectoryIfNeeded({
      directoryName: 'src',
      directoryPath: `${rootPath}/hooks/src`,
      expectedChildText: '__tests__',
      fileTree,
    });
    await expect(fileTree.getByText('__tests__')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('create-debounce.ts')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });

    await expandNextDirectoryIfNeeded({
      directoryName: '__tests__',
      directoryPath: `${rootPath}/hooks/src/__tests__`,
      expectedChildText: 'use-file-filters.test.ts',
      fileTree,
    });
    await expect(fileTree.getByText('use-file-filters.test.ts')).toBeVisible({
      timeout: 15_000,
    });
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

    await hooksCheckbox.click({ noWaitAfter: true, timeout: 5000 });

    await expect(hooksCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(fileTree.getByRole('checkbox', { name: 'Select src' })).toHaveAttribute(
      'data-state',
      'unchecked'
    );
    await expect(fileTree.getByRole('checkbox', { name: 'Select __tests__' })).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  test('promotes a parent folder from indeterminate to checked as child folders are selected one by one', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-e2e';
    await installIncrementalFolderSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const e2eCheckbox = fileTree.getByRole('checkbox', { name: 'Select e2e' });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'unchecked');

    await expandNextDirectoryIfNeeded({
      directoryName: 'e2e',
      directoryPath: `${rootPath}/e2e`,
      expectedChildText: 'page-objects',
      fileTree,
    });
    await expect(fileTree.getByText('page-objects')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('types')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('utils')).toBeVisible({ timeout: 15_000 });

    const pageObjectsCheckbox = fileTree.getByRole('checkbox', { name: 'Select page-objects' });
    const typesCheckbox = fileTree.getByRole('checkbox', { name: 'Select types' });
    const utilsCheckbox = fileTree.getByRole('checkbox', { name: 'Select utils' });

    await pageObjectsCheckbox.click({
      noWaitAfter: true,
      timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS,
    });
    await expect(window.getByText('2/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await typesCheckbox.click({
      noWaitAfter: true,
      timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS,
    });
    await expect(window.getByText('3/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await utilsCheckbox.click({
      noWaitAfter: true,
      timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS,
    });
    await expect(window.getByText('5/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'checked');
  });

  test('clicking an indeterminate parent folder clears all selected descendants', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-e2e-deselect';
    await installIncrementalFolderSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    await expandNextDirectoryIfNeeded({
      directoryName: 'e2e',
      directoryPath: `${rootPath}/e2e`,
      expectedChildText: 'page-objects',
      fileTree,
    });
    await expect(fileTree.getByText('page-objects')).toBeVisible({ timeout: 15_000 });

    const e2eCheckbox = fileTree.getByRole('checkbox', { name: 'Select e2e' });
    const pageObjectsCheckbox = fileTree.getByRole('checkbox', { name: 'Select page-objects' });
    const typesCheckbox = fileTree.getByRole('checkbox', { name: 'Select types' });
    const utilsCheckbox = fileTree.getByRole('checkbox', { name: 'Select utils' });

    await pageObjectsCheckbox.click({ noWaitAfter: true, timeout: 5000 });
    await expect(window.getByText('2/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await e2eCheckbox.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByTestId('selection-count')).toHaveText('0', { timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(pageObjectsCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(typesCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(utilsCheckbox).toHaveAttribute('data-state', 'unchecked');
  });

  test('promotes explicit mixed file-and-folder parents to checked as files are selected one by one', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(FILE_TREE_MULTI_STEP_SELECTION_TEST_TIMEOUT_MS);

    const rootPath = '/mock/desktop-selection-root-hooks-explicit';
    await installMixedHookSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    await expandNextDirectoryIfNeeded({
      directoryName: 'hooks',
      directoryPath: `${rootPath}/hooks`,
      expectedChildText: 'src',
      fileTree,
    });
    await expandNextDirectoryIfNeeded({
      directoryName: 'src',
      directoryPath: `${rootPath}/hooks/src`,
      expectedChildText: '__tests__',
      fileTree,
    });
    await expandNextDirectoryIfNeeded({
      directoryName: '__tests__',
      directoryPath: `${rootPath}/hooks/src/__tests__`,
      expectedChildText: 'use-file-filters.test.ts',
      fileTree,
    });

    const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    const testsCheckbox = fileTree.getByRole('checkbox', { name: 'Select __tests__' });

    await expect(hooksCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(testsCheckbox).toHaveAttribute('data-state', 'unchecked');

    await clickFileTreeCheckboxAndWaitForSelection({
      checkboxName: 'package.json',
      expectedSelectedCount: 1,
      fileTree,
      page: window,
    });
    await clickFileTreeCheckboxAndWaitForSelection({
      checkboxName: 'tsconfig.json',
      expectedSelectedCount: 2,
      fileTree,
      page: window,
    });
    await clickFileTreeCheckboxAndWaitForSelection({
      checkboxName: 'create-debounce.ts',
      expectedSelectedCount: 3,
      fileTree,
      page: window,
    });
    await clickFileTreeCheckboxAndWaitForSelection({
      checkboxName: 'index.ts',
      expectedSelectedCount: 4,
      fileTree,
      page: window,
    });
    await clickFileTreeCheckboxAndWaitForSelection({
      checkboxName: 'use-file-filters.test.ts',
      expectedSelectedCount: 5,
      fileTree,
      page: window,
    });

    await expect(testsCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');
  });

  test('root Select All marks mixed file-and-folder query-selected parents checked after expansion', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-hooks';
    await installMixedHookSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('hooks')).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });
    await waitForFileExplorerSelectionIdle({
      expectedSelectedCount: 5,
      page: window,
    });

    const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

    await expandNextDirectoryIfNeeded({
      directoryName: 'hooks',
      directoryPath: `${rootPath}/hooks`,
      expectedChildText: 'src',
      fileTree,
    });
    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('tsconfig.json')).toBeVisible({ timeout: 15_000 });

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

    await expandNextDirectoryIfNeeded({
      directoryName: 'src',
      directoryPath: `${rootPath}/hooks/src`,
      expectedChildText: '__tests__',
      fileTree,
    });
    await expect(fileTree.getByText('__tests__')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('create-debounce.ts')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });

    await expect(fileTree.getByRole('checkbox', { name: 'Select __tests__' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');
  });
});
