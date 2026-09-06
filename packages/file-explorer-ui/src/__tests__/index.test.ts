import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as index from '../index';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import FileFilterBar, { FileFilterBar as NamedFileFilterBar } from '../shell/file-filter-bar';

// Ensure the barrel file re-exports modules correctly

describe('file-explorer-ui index exports', () => {
  it('delegates owned domain exports through public slice barrels', () => {
    const indexSource = readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    const forbiddenDeepExports = ['./indexing/', './preview/', './shell/', './tree/'].flatMap(
      (slicePath) =>
        indexSource
          .split('\n')
          .filter((line) => line.startsWith('export ') && line.includes(`from '${slicePath}`))
    );

    expect(forbiddenDeepExports).toEqual([]);
    expect(indexSource).toContain("export * from './indexing';");
    expect(indexSource).toContain("export * from './preview';");
    expect(indexSource).toContain("export * from './shell';");
    expect(indexSource).toContain("export * from './tree';");
  });

  it('exports the preview summary without the stale footer component name', () => {
    expect(index).toHaveProperty('PreviewPanelSummary');
    expect(index).not.toHaveProperty('PreviewPanelFooter');
  });

  it('does not expose retired preview footer-height helpers', () => {
    expect(index).not.toHaveProperty('PREVIEW_FOOTER_HEIGHTS');
    expect(index).not.toHaveProperty('clampPreviewFooterHeight');
    expect(index).not.toHaveProperty('getPreviewFooterModeHeight');
    expect(index).not.toHaveProperty('inferPreviewFooterMode');
  });

  it('documents ownership for each public slice barrel', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const publicSlices = ['indexing', 'preview', 'shell', 'tree'] as const;

    for (const slice of publicSlices) {
      const readmePath = path.join(sourceRoot, slice, 'README.md');
      expect(existsSync(readmePath), `${slice} must have an ownership README`).toBe(true);

      const readme = readFileSync(readmePath, 'utf8');
      expect(readme).toContain('## Ownership');
      expect(readme).toContain('## Public surface');
      expect(readme).toContain('## Allowed dependencies');
      expect(readme).toContain('## Focused local test');
    }
  });

  it('keeps tree implementation files inside the tree slice', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const treeImplementationFiles = [
      'file-tree-index.ts',
      'file-tree-provider.tsx',
      'file-tree.tsx',
      'optimized-file-tree.tsx',
      'use-file-tree-context.ts',
      'use-lazy-file-tree.ts',
    ];

    const rootFiles = treeImplementationFiles.filter((fileName) =>
      existsSync(path.join(sourceRoot, fileName))
    );
    const treeFiles = treeImplementationFiles.filter((fileName) =>
      existsSync(path.join(sourceRoot, 'tree', fileName))
    );

    expect(rootFiles).toEqual([]);
    expect(treeFiles).toEqual(treeImplementationFiles);
  });

  it('keeps lazy-tree root-load types out of the implementation cycle and public barrel', () => {
    const treeRoot = path.resolve(process.cwd(), 'src', 'tree');
    const lazyTreeSource = readFileSync(path.join(treeRoot, 'use-lazy-file-tree.ts'), 'utf8');
    const rootLoadSource = readFileSync(
      path.join(treeRoot, 'use-lazy-file-tree-root-load.ts'),
      'utf8'
    );
    const treeIndexSource = readFileSync(path.join(treeRoot, 'index.ts'), 'utf8');

    expect(lazyTreeSource).toContain("from './use-lazy-file-tree-types'");
    expect(rootLoadSource).toContain("from './use-lazy-file-tree-types'");
    expect(rootLoadSource).not.toContain("from './use-lazy-file-tree'");
    expect(lazyTreeSource).not.toMatch(
      /export type (?:RootLoadOutcome\b|\{[^}]*RootLoadOutcome[^}]*\})/s
    );
    expect(treeIndexSource).not.toContain('use-lazy-file-tree-types');
  });

  it('keeps optimized file tree as a composition module under the source-file budget', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const optimizedTreeSource = readFileSync(
      path.join(sourceRoot, 'tree', 'optimized-file-tree.tsx'),
      'utf8'
    );

    expect(optimizedTreeSource.split('\n').length).toBeLessThanOrEqual(1500);
  });

  it('keeps optimized file tree tests split under the test-file budget', () => {
    const testsRoot = path.resolve(process.cwd(), 'src', '__tests__');
    const optimizedTreeTestFiles = [
      'optimized-file-tree.test.tsx',
      'optimized-file-tree-selection.test.tsx',
      'optimized-file-tree-query-expansion.test.tsx',
      'optimized-file-tree-selection-mutations.test.tsx',
    ];

    for (const fileName of optimizedTreeTestFiles) {
      const testSource = readFileSync(path.join(testsRoot, fileName), 'utf8');
      expect(testSource.split('\n').length, fileName).toBeLessThanOrEqual(2000);
    }
  });

  it('keeps background token indexer integration under the source-file budget', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const indexerIntegrationSource = readFileSync(
      path.join(sourceRoot, 'indexing', 'use-background-token-indexer-integration.ts'),
      'utf8'
    );

    expect(indexerIntegrationSource.split('\n').length).toBeLessThanOrEqual(1500);
  });

  it('keeps background token indexer integration tests split under the test-file budget', () => {
    const testsRoot = path.resolve(process.cwd(), 'src', '__tests__');
    const indexerTestFiles = [
      'use-background-token-indexer-integration.test.tsx',
      'use-background-token-indexer-integration-web-resolver.test.tsx',
    ];

    for (const fileName of indexerTestFiles) {
      const testSource = readFileSync(path.join(testsRoot, fileName), 'utf8');
      expect(testSource.split('\n').length, fileName).toBeLessThanOrEqual(2000);
    }
  });

  it('keeps preview implementation files inside the preview slice', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const previewImplementationMoves = [
      ['hooks/use-preview-panel-preferences.ts', 'preview/use-preview-panel-preferences.ts'],
      ['hooks/use-preview-panel-report-actions.ts', 'preview/use-preview-panel-report-actions.ts'],
      ['preview-footer-layout.ts', 'preview/preview-summary-mode.ts'],
      ['preview-panel-footer.tsx', 'preview/preview-panel-summary.tsx'],
      ['preview-panel.tsx', 'preview/preview-panel.tsx'],
      ['use-preview-panel-state.ts', 'preview/use-preview-panel-state.ts'],
    ] as const;

    const legacyFiles = previewImplementationMoves
      .map(([legacyPath]) => legacyPath)
      .filter((filePath) => existsSync(path.join(sourceRoot, filePath)));
    const missingPreviewFiles = previewImplementationMoves
      .map(([, previewPath]) => previewPath)
      .filter((filePath) => !existsSync(path.join(sourceRoot, filePath)));
    const stalePreviewFiles = [
      'preview/preview-footer-layout.ts',
      'preview/preview-panel-footer.tsx',
    ].filter((filePath) => existsSync(path.join(sourceRoot, filePath)));

    expect(legacyFiles).toEqual([]);
    expect(missingPreviewFiles).toEqual([]);
    expect(stalePreviewFiles).toEqual([]);
  });

  it('keeps indexing implementation files inside the indexing slice', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const indexingImplementationMoves = [
      ['hooks/use-text-token-count.ts', 'indexing/use-text-token-count.ts'],
      ['resolve-token-cache-worker-url.ts', 'indexing/resolve-token-cache-worker-url.ts'],
      ['token-budget-control.tsx', 'indexing/token-budget-control.tsx'],
      ['token-cache-context.tsx', 'indexing/token-cache-context.tsx'],
      ['token-meter.tsx', 'indexing/token-meter.tsx'],
      ['token-summary-bar.tsx', 'indexing/token-summary-bar.tsx'],
      [
        'use-background-token-indexer-integration.ts',
        'indexing/use-background-token-indexer-integration.ts',
      ],
      ['use-persistent-token-cache.ts', 'indexing/use-persistent-token-cache.ts'],
      ['use-token-counting.ts', 'indexing/use-token-counting.ts'],
    ] as const;

    const legacyFiles = indexingImplementationMoves
      .map(([legacyPath]) => legacyPath)
      .filter((filePath) => existsSync(path.join(sourceRoot, filePath)));
    const missingIndexingFiles = indexingImplementationMoves
      .map(([, indexingPath]) => indexingPath)
      .filter((filePath) => !existsSync(path.join(sourceRoot, filePath)));

    expect(legacyFiles).toEqual([]);
    expect(missingIndexingFiles).toEqual([]);
  });

  it('keeps shell composition files inside the shell slice', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const shellImplementationMoves = [
      ['file-content-context.tsx', 'shell/file-content-context.tsx'],
      ['file-explorer-panel.tsx', 'shell/file-explorer-panel.tsx'],
      ['file-explorer-middle-panel-base.tsx', 'shell/file-explorer-middle-panel-base.tsx'],
      ['file-explorer-provider.tsx', 'shell/file-explorer-provider.tsx'],
      ['file-explorer-sidebar.tsx', 'shell/file-explorer-sidebar.tsx'],
      ['file-explorer-toolbar.tsx', 'shell/file-explorer-toolbar.tsx'],
      ['file-filter-bar.tsx', 'shell/file-filter-bar.tsx'],
      ['use-file-explorer-context.ts', 'shell/use-file-explorer-context.ts'],
      ['use-file-system-context.ts', 'shell/use-file-system-context.ts'],
      ['use-selection-manager-context.ts', 'shell/use-selection-manager-context.ts'],
      ['workspace-app.ts', 'shell/workspace-app.ts'],
      // BST-1258 split the former workspace-tab-host.tsx into a controller
      // context, strip, body, launcher, and file-tab-body — all shell-sliced.
      ['workspace-tabs-context.tsx', 'shell/workspace-tabs-context.tsx'],
      ['workspace-tab-strip.tsx', 'shell/workspace-tab-strip.tsx'],
      ['workspace-body.tsx', 'shell/workspace-body.tsx'],
      ['workspace-launcher.tsx', 'shell/workspace-launcher.tsx'],
      ['file-tab-body.tsx', 'shell/file-tab-body.tsx'],
    ] as const;

    const legacyFiles = shellImplementationMoves
      .map(([legacyPath]) => legacyPath)
      .filter((filePath) => existsSync(path.join(sourceRoot, filePath)));
    const missingShellFiles = shellImplementationMoves
      .map(([, shellPath]) => shellPath)
      .filter((filePath) => !existsSync(path.join(sourceRoot, filePath)));

    expect(legacyFiles).toEqual([]);
    expect(missingShellFiles).toEqual([]);
  });

  it('should re-export FileFilterBar as named export matching default and named', () => {
    expect(index.FileFilterBar).toBe(FileFilterBar);
    expect(index.FileFilterBar).toBe(NamedFileFilterBar);
  });

  it('should re-export FileExplorerSidebar as named export', () => {
    expect(index.FileExplorerSidebar).toBe(FileExplorerSidebar);
  });

  it('should export ViewFilterPresetDropdown', () => {
    expect(index.ViewFilterPresetDropdown).toBeDefined();
  });

  it('exposes stable domain barrels for tree, preview, indexing, and shell responsibilities', async () => {
    const [tree, preview, indexing, shell] = await Promise.all([
      import('../tree'),
      import('../preview'),
      import('../indexing'),
      import('../shell'),
    ]);

    expect(tree.FileTree).toBe(index.FileTree);
    expect(tree.OptimizedFileTree).toBe(index.OptimizedFileTree);
    expect(tree.useFileTree).toBe(index.useFileTree);
    expect(tree.readFullTreeWithOptions).toBe(index.readFullTreeWithOptions);

    expect(preview.PreviewPanel).toBe(index.PreviewPanel);
    expect(preview.usePreviewPanelState).toBe(index.usePreviewPanelState);

    expect(indexing.TokenCacheProvider).toBe(index.TokenCacheProvider);
    expect(indexing.useOptionalTokenCacheContext).toBe(index.useOptionalTokenCacheContext);
    expect(indexing.useBackgroundTokenIndexerIntegration).toBe(
      index.useBackgroundTokenIndexerIntegration
    );

    expect(shell.FileExplorerProvider).toBe(index.FileExplorerProvider);
    expect(shell.FileExplorerPanel).toBe(index.FileExplorerPanel);
    expect(shell.WorkspaceTabsProvider).toBe(index.WorkspaceTabsProvider);
    expect(shell.WorkspaceTabStrip).toBe(index.WorkspaceTabStrip);
    expect(shell.WorkspaceBody).toBe(index.WorkspaceBody);
    expect(shell.useFileExplorer).toBe(index.useFileExplorer);
    expect(shell.useFileSystem).toBe(index.useFileSystem);
    expect(shell.useSelectionManager).toBe(index.useSelectionManager);
  });
});
