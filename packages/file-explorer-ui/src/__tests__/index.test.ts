import { describe, expect, it } from 'vitest';
import FileExtensionFilter from '../file-extension-filter';
import FileFilterBar, { FileFilterBar as NamedFileFilterBar } from '../file-filter-bar';
import * as index from '../index';

// Ensure the barrel file re-exports modules correctly

describe('file-explorer-ui index exports', () => {
  it('should re-export FileExtensionFilter as named export', () => {
    expect(index.FileExtensionFilter).toBe(FileExtensionFilter);
  });

  it('should re-export FileFilterBar as named export matching default and named', () => {
    expect(index.FileFilterBar).toBe(FileFilterBar);
    expect(index.FileFilterBar).toBe(NamedFileFilterBar);
  });
});
