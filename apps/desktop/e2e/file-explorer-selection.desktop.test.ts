import {
  clickExplorerTreeAction,
  clickFileTreeCheckboxAndWaitForSelection,
  ensureFileExplorerPanelVisible,
  expandDirectoryIfNeeded,
  expandNextDirectoryIfNeeded,
  expect,
  expectExplorerTreeActionsReachable,
  expectFileSelected,
  FILE_EXPLORER_CLICK_TIMEOUT_MS,
  FILE_TREE_MULTI_STEP_SELECTION_TEST_TIMEOUT_MS,
  getExpandedDirectoryCount,
  installIncrementalFolderSelectionFixture,
  installMixedHookSelectionFixture,
  installNestedFolderFixture,
  installNestedPackagesFixture,
  installWideExpandAllFixture,
  setFileExplorerMaxSelectionCount,
  test,
  WIDE_EXPAND_ALL_TOTAL_DIRECTORY_COUNT,
  waitForFileExplorerSelectionIdle,
} from './file-explorer-selection.shared';

test.describe('Desktop file explorer selection', () => {
  test('root Select All marks visible folders checked when recursive descendants are selected', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-full');
    await ensureFileExplorerPanelVisible(window);

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
    await ensureFileExplorerPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByRole('treegrid', { name: 'File tree' })).toBeVisible({
      timeout: 15_000,
    });
    const initialExpandedCount = await getExpandedDirectoryCount(window);
    // Responsive since BST-1208: at the desktop Explorer's 180px default this
    // action lives in the compact menu, not as a bare button.
    await clickExplorerTreeAction(window, 'expand-all');

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
    // The sweep is still running — observable through the cancel affordance,
    // which is the control BST-657 guarantees at this width (the expand button
    // itself is in the compact menu here, and that menu yields mid-sweep).
    await expect(cancelButton).toBeVisible();

    // No tolerance branch: the fixture's per-read delay keeps the traversal
    // running for ~13.5s, so a cancel click that misses is a real failure, not
    // an operation that legitimately finished first.
    await cancelButton.click({ noWaitAfter: true, timeout: 5000 });

    await expect(window.getByTestId('inline-scanning-indicator')).not.toBeVisible({
      timeout: 15_000,
    });
    await expectExplorerTreeActionsReachable(window);

    const expandedCountAfterCancel = await getExpandedDirectoryCount(window);
    expect(expandedCountAfterCancel).toBeGreaterThan(initialExpandedCount);
    expect(expandedCountAfterCancel).toBeLessThan(
      initialExpandedCount + WIDE_EXPAND_ALL_TOTAL_DIRECTORY_COUNT
    );
  });

  test('unchecking a selected folder removes its files from the selection on desktop', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-context-deselect');
    await ensureFileExplorerPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
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

  test('root capped Select All marks visible folders indeterminate when only some descendants are selected', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-capped');
    await ensureFileExplorerPanelVisible(window);

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
    await ensureFileExplorerPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ noWaitAfter: true, timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 2);

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ noWaitAfter: true, timeout: 5000 });

    const limitToast = window.getByText('Selection limit reached (2)', { exact: true }).first();
    await expect(limitToast).toBeVisible({ timeout: 15_000 });
    await expect(
      window
        .getByText('Selected 2 files before hitting the limit. Raise the limit to select more.', {
          exact: true,
        })
        .first()
    ).toBeVisible();
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

  test.fixme('root Select All keeps expanded folders fully checked when all descendants are selected', {
    annotation: { description: 'BST-1953', type: 'quarantine' },
  }, async ({ electronApp, window }) => {
    test.setTimeout(45_000);

    await installNestedPackagesFixture(electronApp.app, '/mock/desktop-selection-root-packages');
    await ensureFileExplorerPanelVisible(window);

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
    await ensureFileExplorerPanelVisible(window);

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
    await ensureFileExplorerPanelVisible(window);

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

  test('clicking an indeterminate parent folder completes then clears its descendants', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-e2e-deselect';
    await installIncrementalFolderSelectionFixture(electronApp.app, rootPath);
    await ensureFileExplorerPanelVisible(window);

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

    // Decision D1 (#1588): clicking an indeterminate folder COMPLETES the
    // selection of its descendants rather than clearing them.
    await e2eCheckbox.click({ noWaitAfter: true, timeout: 5000 });
    await expect(window.getByTestId('selection-count')).toHaveText('5', { timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(pageObjectsCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(typesCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(utilsCheckbox).toHaveAttribute('data-state', 'checked');

    // A second click on the now-checked folder clears the whole subtree.
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
    await ensureFileExplorerPanelVisible(window);

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
    await ensureFileExplorerPanelVisible(window);

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
