import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import FileExplorerSidebar from '../file-explorer-sidebar';
import FileFilterBar, { FileFilterBar as NamedFileFilterBar } from '../file-filter-bar';
import * as index from '../index';

// Ensure the barrel file re-exports modules correctly

describe('file-explorer-ui index exports', () => {
  it('keeps tree implementation files inside the tree slice', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const treeImplementationFiles = [
      'file-tree-index.ts',
      'file-tree-node.tsx',
      'file-tree-provider.tsx',
      'file-tree.tsx',
      'optimized-file-tree.tsx',
      'use-file-tree-context.ts',
      'use-file-tree-node-selection.ts',
      'use-lazy-file-tree.ts',
      'use-virtual-list.ts',
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

  it('keeps preview implementation files inside the preview slice', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const previewImplementationMoves = [
      ['hooks/use-preview-panel-persistence.ts', 'preview/use-preview-panel-persistence.ts'],
      ['hooks/use-preview-panel-preferences.ts', 'preview/use-preview-panel-preferences.ts'],
      ['hooks/use-preview-panel-report-actions.ts', 'preview/use-preview-panel-report-actions.ts'],
      ['preview-column-visibility-controls.tsx', 'preview/preview-column-visibility-controls.tsx'],
      ['preview-column-visibility.ts', 'preview/preview-column-visibility.ts'],
      ['preview-footer-layout.ts', 'preview/preview-footer-layout.ts'],
      ['preview-panel-footer.tsx', 'preview/preview-panel-footer.tsx'],
      ['preview-panel.tsx', 'preview/preview-panel.tsx'],
      ['preview-table-row.tsx', 'preview/preview-table-row.tsx'],
      ['preview-table.tsx', 'preview/preview-table.tsx'],
      ['preview-view-toolbar.tsx', 'preview/preview-view-toolbar.tsx'],
      ['use-preview-panel-state.ts', 'preview/use-preview-panel-state.ts'],
    ] as const;

    const legacyFiles = previewImplementationMoves
      .map(([legacyPath]) => legacyPath)
      .filter((filePath) => existsSync(path.join(sourceRoot, filePath)));
    const missingPreviewFiles = previewImplementationMoves
      .map(([, previewPath]) => previewPath)
      .filter((filePath) => !existsSync(path.join(sourceRoot, filePath)));

    expect(legacyFiles).toEqual([]);
    expect(missingPreviewFiles).toEqual([]);
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
    expect(shell.FileExplorerLeftPanel).toBe(index.FileExplorerLeftPanel);
    expect(shell.WorkspaceTabHost).toBe(index.WorkspaceTabHost);
    expect(shell.useFileExplorer).toBe(index.useFileExplorer);
    expect(shell.useFileSystem).toBe(index.useFileSystem);
    expect(shell.useSelectionManager).toBe(index.useSelectionManager);
  });
});
