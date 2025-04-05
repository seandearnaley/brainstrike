import { describe, expect, it, vi } from 'vitest';
import { createDirectoryActions } from '../directory-actions';
describe('directory-actions', () => {
    // Setup common mocks
    const mockSet = vi.fn();
    beforeEach(() => {
        mockSet.mockClear();
    });
    // Helper to create a full mock state
    const createMockState = (overrides = {}) => ({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: new Set(),
        expandedDirectoryPaths: new Set(),
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 100,
        maxSelectionCount: 100,
        lastActiveTab: 'files',
        setCurrentFolderId: vi.fn(),
        hydrateFolderState: vi.fn(),
        setSelectedFiles: vi.fn(),
        addSelectedFile: vi.fn(),
        removeSelectedFile: vi.fn(),
        toggleSelectedFile: vi.fn(),
        clearSelectedFiles: vi.fn(),
        setExpandedPaths: vi.fn(),
        toggleDirectoryExpansion: vi.fn(),
        setFilters: vi.fn(),
        setUseRegex: vi.fn(),
        setIncludeProjectTree: vi.fn(),
        setFolderSummaryThreshold: vi.fn(),
        setMaxSelectionCount: vi.fn(),
        setLastActiveTab: vi.fn(),
        expandAllDirectories: vi.fn(),
        collapseAllDirectories: vi.fn(),
        ...overrides,
    });
    describe('setExpandedPaths', () => {
        it('should set expanded paths', () => {
            // Arrange
            const paths = new Set(['dir1', 'dir2/subdir']);
            const get = vi.fn();
            const directoryActions = createDirectoryActions(mockSet, get);
            // Act
            directoryActions.setExpandedPaths(paths);
            // Assert
            expect(mockSet).toHaveBeenCalledTimes(1);
            // Check that the function passed to set returns the correct state update
            const stateUpdateFn = mockSet.mock.calls[0][0];
            const updatedState = stateUpdateFn({});
            expect(updatedState).toEqual({
                expandedDirectoryPaths: new Set(['dir1', 'dir2/subdir']),
            });
            // Verify the sets are different instances (to avoid shared references)
            expect(updatedState.expandedDirectoryPaths).not.toBe(paths);
        });
        it('should handle empty sets', () => {
            // Arrange
            const paths = new Set();
            const get = vi.fn();
            const directoryActions = createDirectoryActions(mockSet, get);
            // Act
            directoryActions.setExpandedPaths(paths);
            // Assert
            expect(mockSet).toHaveBeenCalledTimes(1);
            const stateUpdateFn = mockSet.mock.calls[0][0];
            const updatedState = stateUpdateFn({});
            expect(updatedState).toEqual({
                expandedDirectoryPaths: new Set(),
            });
        });
    });
    describe('toggleDirectoryExpansion', () => {
        it('should add path to expanded paths when not present', () => {
            // Arrange
            const path = 'dir1/newdir';
            const mockState = createMockState({
                expandedDirectoryPaths: new Set(['dir1', 'dir2']),
            });
            const get = vi.fn(() => mockState);
            const directoryActions = createDirectoryActions(mockSet, get);
            // Act
            directoryActions.toggleDirectoryExpansion(path);
            // Assert
            expect(get).toHaveBeenCalledTimes(1);
            expect(mockSet).toHaveBeenCalledTimes(1);
            // Check state update
            const stateUpdateFn = mockSet.mock.calls[0][0];
            const updatedState = stateUpdateFn({});
            // Should now contain the new path
            expect(updatedState.expandedDirectoryPaths.has('dir1')).toBe(true);
            expect(updatedState.expandedDirectoryPaths.has('dir2')).toBe(true);
            expect(updatedState.expandedDirectoryPaths.has('dir1/newdir')).toBe(true);
            expect(updatedState.expandedDirectoryPaths.size).toBe(3);
        });
        it('should remove path from expanded paths when present', () => {
            // Arrange
            const path = 'dir1';
            const mockState = createMockState({
                expandedDirectoryPaths: new Set(['dir1', 'dir2']),
            });
            const get = vi.fn(() => mockState);
            const directoryActions = createDirectoryActions(mockSet, get);
            // Act
            directoryActions.toggleDirectoryExpansion(path);
            // Assert
            expect(get).toHaveBeenCalledTimes(1);
            expect(mockSet).toHaveBeenCalledTimes(1);
            // Check state update
            const stateUpdateFn = mockSet.mock.calls[0][0];
            const updatedState = stateUpdateFn({});
            // Should have removed dir1
            expect(updatedState.expandedDirectoryPaths.has('dir1')).toBe(false);
            expect(updatedState.expandedDirectoryPaths.has('dir2')).toBe(true);
            expect(updatedState.expandedDirectoryPaths.size).toBe(1);
        });
        it('should handle toggling when expanded paths is empty', () => {
            // Arrange
            const path = 'dir1';
            const mockState = createMockState({
                expandedDirectoryPaths: new Set(),
            });
            const get = vi.fn(() => mockState);
            const directoryActions = createDirectoryActions(mockSet, get);
            // Act
            directoryActions.toggleDirectoryExpansion(path);
            // Assert
            expect(get).toHaveBeenCalledTimes(1);
            expect(mockSet).toHaveBeenCalledTimes(1);
            // Check state update
            const stateUpdateFn = mockSet.mock.calls[0][0];
            const updatedState = stateUpdateFn({});
            // Should have added dir1
            expect(updatedState.expandedDirectoryPaths.has('dir1')).toBe(true);
            expect(updatedState.expandedDirectoryPaths.size).toBe(1);
        });
    });
});
