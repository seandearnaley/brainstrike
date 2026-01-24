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
});
