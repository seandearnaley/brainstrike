import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureFileExplorerPanelVisible,
  expandDirectoryIfNeeded,
  expect,
  expectContextExplorerFileVisibility,
  seedLive3dmolRestoreState,
  seedRestoredExplicitSelectionState,
  seedRestoredQuerySelectionState,
  seedSelectionSnapshotRows,
  test,
  toggleFileTreeCheckboxAndWaitForSelection,
} from './file-explorer-selection.shared';

test.describe('Desktop file explorer selection restore', () => {
  test('restored folder stays responsive while Expand All materializes nested files', async ({
    electronHarness,
  }) => {
    test.setTimeout(90_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-expand-all-restore-'));
    const deepFileName = 'file-23-3.ts';

    try {
      for (let directoryIndex = 0; directoryIndex < 24; directoryIndex += 1) {
        const srcPath = path.join(rootPath, 'packages', `pkg-${directoryIndex}`, 'src');
        await mkdir(srcPath, { recursive: true });
        for (let fileIndex = 0; fileIndex < 4; fileIndex += 1) {
          await writeFile(
            path.join(srcPath, `file-${directoryIndex}-${fileIndex}.ts`),
            `export const fixture = ${directoryIndex * 10 + fileIndex};`
          );
        }
      }

      await seedRestoredExplicitSelectionState({
        electronHarness,
        rootPath,
        expandedDirectoryPaths: [],
        selectedFilePaths: [],
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });

      const filterInput = restartedWindow.getByTestId('file-filter-input');
      await expect(filterInput).toBeVisible({ timeout: 15_000 });

      const expandAllButton = restartedWindow.getByTestId('expand-all-button-small');
      await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
      await expandAllButton.click({ noWaitAfter: true });

      await filterInput.fill('file-23', { timeout: 5000 });
      await expect(filterInput).toHaveValue('file-23');
      await expect(fileTree.getByText(deepFileName)).toBeVisible({ timeout: 30_000 });

      await filterInput.fill('');
      await expect(filterInput).toHaveValue('');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored explicit folders can be deselected and reselected after app restart', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-'));

    try {
      await mkdir(path.join(rootPath, 'hooks/src/__tests__'), { recursive: true });
      await writeFile(path.join(rootPath, 'hooks/package.json'), '{"name":"hooks"}');
      await writeFile(path.join(rootPath, 'hooks/src/create-debounce.ts'), 'export const x = 1;');
      await writeFile(path.join(rootPath, 'hooks/src/index.ts'), 'export const y = 1;');
      await writeFile(
        path.join(rootPath, 'hooks/src/__tests__/use-file-filters.test.ts'),
        'export const z = 1;'
      );

      await seedRestoredExplicitSelectionState({
        electronHarness,
        rootPath,
        expandedDirectoryPaths: [
          path.join(rootPath, 'hooks'),
          path.join(rootPath, 'hooks/src'),
          path.join(rootPath, 'hooks/src/__tests__'),
        ],
        selectedFilePaths: [
          path.join(rootPath, 'hooks/package.json'),
          path.join(rootPath, 'hooks/src/create-debounce.ts'),
          path.join(rootPath, 'hooks/src/index.ts'),
          path.join(rootPath, 'hooks/src/__tests__/use-file-filters.test.ts'),
        ],
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('4', {
        timeout: 15_000,
      });

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const testsCheckbox = fileTree.getByRole('checkbox', { name: 'Select __tests__' });

      await expect(fileTree.getByText('hooks')).toBeVisible({ timeout: 15_000 });
      await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'hooks',
        expectedCheckboxStateBefore: 'checked',
        expectedCheckboxStateAfter: 'unchecked',
        expectedSelectedCountBefore: 4,
        expectedSelectedCountAfter: 0,
        fileTree,
        page: restartedWindow,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'hooks',
        expectedCheckboxStateBefore: 'unchecked',
        expectedCheckboxStateAfter: 'checked',
        expectedSelectedCountBefore: 0,
        expectedSelectedCountAfter: 4,
        fileTree,
        page: restartedWindow,
      });

      await expandDirectoryIfNeeded({
        directoryName: 'hooks',
        expectedChildText: 'src',
        fileTree,
        page: restartedWindow,
      });
      await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 15_000 });

      await expandDirectoryIfNeeded({
        directoryName: 'src',
        expectedChildText: 'create-debounce.ts',
        fileTree,
        page: restartedWindow,
      });
      await expect(fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });
      await expect(fileTree.getByText('__tests__')).toBeVisible({ timeout: 15_000 });

      await expandDirectoryIfNeeded({
        directoryName: '__tests__',
        expectedChildText: 'use-file-filters.test.ts',
        fileTree,
        page: restartedWindow,
      });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(testsCheckbox).toHaveAttribute('data-state', 'checked');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored partial explicit selection remains interactive after app restart', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-partial-'));

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'docs'), { recursive: true });
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(
        path.join(rootPath, 'src/components/viewer.tsx'),
        'export const Viewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'docs/guide.ts'), 'export const guide = 1;');

      await seedRestoredExplicitSelectionState({
        electronHarness,
        rootPath,
        expandedDirectoryPaths: [path.join(rootPath, 'src')],
        selectedFilePaths: [
          path.join(rootPath, 'src/main.tsx'),
          path.join(rootPath, 'src/vite-env.d.ts'),
        ],
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('2', {
        timeout: 15_000,
      });

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      await expandDirectoryIfNeeded({
        directoryName: path.basename(rootPath),
        expectedChildText: 'src',
        fileTree,
        page: restartedWindow,
      });

      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const mainCheckbox = fileTree.getByRole('checkbox', { name: 'Select main.tsx' });
      const viteCheckbox = fileTree.getByRole('checkbox', { name: 'Select vite-env.d.ts' });
      const appCheckbox = fileTree.getByRole('checkbox', { name: 'Select App.tsx' });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
      await expect(mainCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(viteCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(appCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: true,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'main.tsx',
        expectedCheckboxStateBefore: 'checked',
        expectedCheckboxStateAfter: 'unchecked',
        expectedSelectedCountBefore: 2,
        expectedSelectedCountAfter: 1,
        fileTree,
        page: restartedWindow,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: false,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'App.tsx',
        expectedCheckboxStateBefore: 'unchecked',
        expectedCheckboxStateAfter: 'checked',
        expectedSelectedCountBefore: 1,
        expectedSelectedCountAfter: 2,
        fileTree,
        page: restartedWindow,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
      await expectContextExplorerFileVisibility({
        fileName: 'App.tsx',
        page: restartedWindow,
        visible: true,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'src',
        expectedCheckboxStateBefore: 'indeterminate',
        expectedCheckboxStateAfter: 'unchecked',
        expectedSelectedCountBefore: 2,
        expectedSelectedCountAfter: 0,
        fileTree,
        page: restartedWindow,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: false,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: false,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'App.tsx',
        page: restartedWindow,
        visible: false,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'src',
        expectedCheckboxStateBefore: 'unchecked',
        expectedCheckboxStateAfter: 'checked',
        expectedSelectedCountBefore: 0,
        expectedSelectedCountAfter: 5,
        fileTree,
        page: restartedWindow,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'App.tsx',
        page: restartedWindow,
        visible: true,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'src',
        expectedCheckboxStateBefore: 'checked',
        expectedCheckboxStateAfter: 'unchecked',
        expectedSelectedCountBefore: 5,
        expectedSelectedCountAfter: 0,
        fileTree,
        page: restartedWindow,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'docs',
        expectedCheckboxStateBefore: 'unchecked',
        expectedCheckboxStateAfter: 'checked',
        expectedSelectedCountBefore: 0,
        expectedSelectedCountAfter: 1,
        fileTree,
        page: restartedWindow,
      });

      await toggleFileTreeCheckboxAndWaitForSelection({
        checkboxName: 'docs',
        expectedCheckboxStateBefore: 'checked',
        expectedCheckboxStateAfter: 'unchecked',
        expectedSelectedCountBefore: 1,
        expectedSelectedCountAfter: 0,
        fileTree,
        page: restartedWindow,
      });
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored filtered query selections remain interactive before the manifest snapshot loads', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-query-'));

    try {
      await mkdir(path.join(rootPath, 'public'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/types'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'public/config.json'), '{"public":true}');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/types/viewer.d.ts'), 'export type Viewer = string;');
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/vite-env.d.ts'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/types/viewer.d.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
        ],
        coveredDirectoryPaths: [
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
        ],
        includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });

      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const componentsCheckbox = fileTree.getByRole('checkbox', { name: 'Select components' });
      const publicCheckbox = fileTree.getByRole('checkbox', { name: 'Select public' });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(publicCheckbox).toHaveAttribute('data-state', 'unchecked');

      await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });

      await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      await componentsCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length - 1),
        {
          timeout: 15_000,
        }
      );

      await publicCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(publicCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored query selections compute token totals from materialized descendants', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-query-tokens-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [rootPath],
        coveredDirectoryPaths: [
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/utils'),
        ],
        includeFilters: ['*.tsx', '*.ts'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
      await expect(fileTree.getByText('molecule-viewer.tsx')).toBeVisible({ timeout: 15_000 });

      const tokenSummary = restartedWindow.getByText(/[1-9]\d*(?:,\d{3})* output/);
      await expect(tokenSummary).toBeVisible({ timeout: 20_000 });
      await expect(restartedWindow.getByText(/estimating…/)).not.toBeVisible({ timeout: 20_000 });
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored root-level query-selected folders remain interactive after app restart', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-root-query-'));

    try {
      await mkdir(path.join(rootPath, 'public'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'docs'), { recursive: true });

      await writeFile(path.join(rootPath, 'public/config.json'), '{"public":true}');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(
        path.join(rootPath, 'src/components/viewer.tsx'),
        'export const Viewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'docs/guide.ts'), 'export const guide = 1;');

      const materializedPaths = [
        path.join(rootPath, 'public/config.json'),
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/components/viewer.tsx'),
        path.join(rootPath, 'docs/guide.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: rootPath,
        expandedDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'public'),
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'docs'),
        ],
        coveredDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'public'),
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'docs'),
        ],
        includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });

      const publicCheckbox = fileTree.getByRole('checkbox', { name: 'Select public' });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const docsCheckbox = fileTree.getByRole('checkbox', { name: 'Select docs' });

      await expect(publicCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(docsCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('2', {
        timeout: 15_000,
      });

      await publicCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(publicCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1', {
        timeout: 15_000,
      });

      await docsCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(docsCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored query selections with manual included paths stay interactive after the post-click settle window', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-root-query-included-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/types'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'eslint.config.js'), 'export default [];');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/types/viewer.d.ts'), 'export type Viewer = string;');
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/vite-env.d.ts'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/types/viewer.d.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
        ],
        coveredDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
        ],
        includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        includedPaths: [path.join(rootPath, 'eslint.config.js')],
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('8', {
        timeout: 15_000,
      });

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const eslintCheckbox = fileTree.getByRole('checkbox', { name: 'Select eslint.config.js' });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(eslintCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1', {
        timeout: 15_000,
      });

      await restartedWindow.waitForTimeout(1200);
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(eslintCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('snapshot-backed restored root folders stay interactive after the post-click settle window', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-snapshot-root-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/types'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/types/viewer.d.ts'), 'export type Viewer = string;');
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const snapshotId = '11111111-2222-4333-8444-555555555555';
      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/vite-env.d.ts'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/types/viewer.d.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedSelectionSnapshotRows({
        electronHarness,
        snapshotId,
        filePaths: materializedPaths,
      });

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          '/Users',
          '/Users/seandearnaley',
          '/Users/seandearnaley/Documents',
          '/Users/seandearnaley/Documents/GitHub',
          rootPath,
          path.join(rootPath, 'src'),
        ],
        coveredDirectoryPaths: [
          '/Users',
          '/Users/seandearnaley',
          '/Users/seandearnaley/Documents',
          '/Users/seandearnaley/Documents/GitHub',
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
        ],
        includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        manifestSnapshotId: snapshotId,
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('7', {
        timeout: 15_000,
      });

      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });

      await restartedWindow.waitForTimeout(1200);
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored snapshot-backed query parents ignore unmatched child directories when computing root checkbox state', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-snapshot-unmatched-child-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/assets'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });

      await writeFile(path.join(rootPath, 'src/assets/react.svg'), '<svg />');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(
        path.join(rootPath, 'src/components/viewer.tsx'),
        'export const Viewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );

      const snapshotId = '22222222-3333-4444-8555-666666666666';
      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/components/viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
      ];

      await seedSelectionSnapshotRows({
        electronHarness,
        snapshotId,
        filePaths: materializedPaths,
      });

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          '/Users',
          '/Users/seandearnaley',
          '/Users/seandearnaley/Documents',
          '/Users/seandearnaley/Documents/GitHub',
          rootPath,
          path.join(rootPath, 'src'),
        ],
        coveredDirectoryPaths: [
          '/Users',
          '/Users/seandearnaley',
          '/Users/seandearnaley/Documents',
          '/Users/seandearnaley/Documents/GitHub',
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
        ],
        includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        manifestSnapshotId: snapshotId,
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('4', {
        timeout: 15_000,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });

      await restartedWindow.waitForTimeout(1200);
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('isolated replay of the live 3dmol-react restore state keeps the restored root folder interactive', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-3dmol-restore-'));

    try {
      await seedLive3dmolRestoreState({ electronHarness, rootPath });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureFileExplorerPanelVisible(restartedWindow);

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('15', {
        timeout: 15_000,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ noWaitAfter: true, timeout: 5000 });
      await restartedWindow.waitForTimeout(1200);

      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });
});
