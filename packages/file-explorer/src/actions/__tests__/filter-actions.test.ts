import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFilterActions } from '../filter-actions';

describe('filter-actions', () => {
  // Setup common mocks
  const mockSet = vi.fn();
  const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    mockSet.mockClear();
    consoleSpy.mockClear();
  });

  describe('setFilters', () => {
    it('should set include and exclude filters', () => {
      // Arrange
      const includeFilters = ['*.ts', '*.tsx'];
      const excludeFilters = ['*.test.ts', 'node_modules'];
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setFilters(includeFilters, excludeFilters);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toEqual({
        includeFilters: ['*.ts', '*.tsx'],
        excludeFilters: ['*.test.ts', 'node_modules'],
      });
    });

    it('should handle empty filter arrays', () => {
      // Arrange
      const includeFilters: string[] = [];
      const excludeFilters: string[] = [];
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setFilters(includeFilters, excludeFilters);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toEqual({
        includeFilters: [],
        excludeFilters: [],
      });
    });
  });

  describe('setUseRegex', () => {
    it('should set useRegex flag to true', () => {
      // Arrange
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setUseRegex(true);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toEqual({
        useRegex: true,
      });
    });

    it('should set useRegex flag to false', () => {
      // Arrange
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setUseRegex(false);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toEqual({
        useRegex: false,
      });
    });
  });

  describe('setIncludeProjectTree', () => {
    it('should set includeProjectTree flag to true', () => {
      // Arrange
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setIncludeProjectTree(true);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toEqual({
        includeProjectTree: true,
      });
    });

    it('should set includeProjectTree flag to false', () => {
      // Arrange
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setIncludeProjectTree(false);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toEqual({
        includeProjectTree: false,
      });
    });
  });

  describe('setFolderSummaryThreshold', () => {
    it('should set folder summary threshold to valid value', () => {
      // Arrange
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setFolderSummaryThreshold(500);

      // Assert
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toEqual({
        folderSummaryThreshold: 500,
      });
    });

    it('should handle negative values with a warning', () => {
      // Arrange
      const filterActions = createFilterActions(mockSet);

      // Act
      filterActions.setFolderSummaryThreshold(-50);

      // Assert
      expect(consoleSpy).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls.length).toBeGreaterThan(0);
      const arg = mockSet.mock.calls[0]?.[0];
      expect(arg).toBeDefined();

      let updatedState: Partial<FileExplorerState> | undefined;
      if (typeof arg === 'function') {
        updatedState = arg({} as FileExplorerState);
      } else {
        updatedState = arg as Partial<FileExplorerState>;
      }

      expect(updatedState).toBeDefined();
      expect(updatedState).toHaveProperty('folderSummaryThreshold');
    });
  });
});
