import { describe, expect, it } from 'vitest';
import FileExplorerSidebar from '../file-explorer-sidebar';
import FileFilterBar, { FileFilterBar as NamedFileFilterBar } from '../file-filter-bar';
import * as index from '../index';

// Ensure the barrel file re-exports modules correctly

describe('file-explorer-ui index exports', () => {
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
