import { describe, expect, it } from 'vitest';
import * as index from '../index';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import FileFilterBar, { FileFilterBar as NamedFileFilterBar } from '../shell/file-filter-bar';

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

  it('exposes stable domain barrels for tree, indexing, and shell responsibilities', async () => {
    const [tree, indexing, shell] = await Promise.all([
      import('../tree'),
      import('../indexing'),
      import('../shell'),
    ]);

    expect(tree.FileTree).toBe(index.FileTree);
    expect(tree.OptimizedFileTree).toBe(index.OptimizedFileTree);
    expect(tree.useFileTree).toBe(index.useFileTree);
    expect(tree.readFullTreeWithOptions).toBe(index.readFullTreeWithOptions);

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
