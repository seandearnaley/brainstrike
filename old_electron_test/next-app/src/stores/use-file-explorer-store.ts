/**
 * File Explorer Store
 *
 * This store manages the state of the file explorer, including selected files, expanded directories,
 * and folder-specific states. It uses Zustand with persistence to maintain state across page reloads.
 *
 * IMPORTANT IMPLEMENTATION NOTES:
 *
 * 1. Set Handling:
 *    - We use Sets for file paths and directory paths for O(1) lookups
 *    - Sets cannot be directly serialized/deserialized in localStorage
 *    - When rehydrating state, we must explicitly create new Set instances
 *    - Never spread Sets (e.g., ...existingSet) as this breaks the prototype chain
 *
 * 2. State Structure:
 *    - Top level state contains current selections and global settings
 *    - Folder-specific state is stored in folderStates map
 *    - We limit the number of stored folder states to prevent memory issues
 *
 * 3. Type Safety:
 *    - Always use optional chaining (?.) when accessing potentially undefined properties
 *    - Use type guards (Array.isArray, typeof) before type coercion
 *    - Provide explicit fallbacks for all potentially undefined values
 *
 * 4. State Persistence:
 *    - State is serialized to localStorage as arrays and deserialized back to Sets
 *    - The serialized format (SerializedState) differs from runtime format (FileExplorerState)
 *    - Always validate persisted data during rehydration as it could be corrupted
 */

import { encodeFileSelection } from '@/utils/file-selection-utils';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistOptions } from './persistence/file-explorer-persistence';
import type { FileExplorerState } from './types/file-explorer-types';
import { DEFAULT_STATE } from './types/file-explorer-types';
import {
  cleanupOldFolderStates,
  createNewFolderState,
  saveFolderState,
} from './utils/file-explorer-utils';

// Helper function to handle folder state reset
const getResetState = () => {
  // Get the current state to preserve certain settings
  const currentState = useFileExplorerStore.getState();

  return {
    currentFolderId: null,
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    includeFilters: DEFAULT_STATE.includeFilters,
    excludeFilters: DEFAULT_STATE.excludeFilters,
    useRegex: DEFAULT_STATE.useRegex,
    // Preserve the current value of includeProjectTree instead of resetting to default
    includeProjectTree: currentState.includeProjectTree,
    folderSummaryThreshold: currentState.folderSummaryThreshold,
    maxSelectionCount: currentState.maxSelectionCount,
    lastActiveTab: currentState.lastActiveTab,
  };
};

export const useFileExplorerStore = create<FileExplorerState>()(
  persist(
    (set) => ({
      // Initial state
      currentFolderId: null,
      folderStates: {},
      selectedFilePaths: new Set<string>(),
      expandedDirectoryPaths: new Set<string>(),
      includeFilters: DEFAULT_STATE.includeFilters,
      excludeFilters: DEFAULT_STATE.excludeFilters,
      useRegex: DEFAULT_STATE.useRegex,
      includeProjectTree: DEFAULT_STATE.includeProjectTree,
      folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
      maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
      lastActiveTab: DEFAULT_STATE.lastActiveTab,

      // Actions
      setCurrentFolderId: (folderId: string | null) =>
        set((state) => {
          const now = Date.now();

          // Save current folder state if it exists
          if (state.currentFolderId) {
            saveFolderState(state, state.currentFolderId, now);
          }

          if (!folderId) {
            return getResetState();
          }

          const existing = state.folderStates[folderId];
          if (existing) {
            // Return existing folder state
            saveFolderState(state, folderId, now);
            cleanupOldFolderStates(state);

            return {
              ...state,
              currentFolderId: folderId,
              selectedFilePaths: new Set(Array.from(existing.selectedFilePaths)),
              expandedDirectoryPaths: new Set(Array.from(existing.expandedDirectoryPaths)),
              includeFilters: [...existing.includeFilters],
              excludeFilters: [...existing.excludeFilters],
              useRegex: existing.useRegex,
              includeProjectTree: existing.includeProjectTree,
              folderSummaryThreshold: existing.folderSummaryThreshold,
              maxSelectionCount: existing.maxSelectionCount,
              lastActiveTab: existing.lastActiveTab,
            };
          }

          // Create new folder state
          const newFolderState = createNewFolderState(state, now);
          saveFolderState(state, folderId, now);
          cleanupOldFolderStates(state);

          return {
            ...state,
            currentFolderId: folderId,
            folderStates: {
              ...state.folderStates,
              [folderId]: newFolderState,
            },
          };
        }),

      hydrateFolderState: (folderId: string) =>
        set((state) => {
          const folderState = state.folderStates[folderId];
          if (!folderState) return state;

          return {
            ...state,
            selectedFilePaths: new Set(Array.from(folderState.selectedFilePaths)),
            expandedDirectoryPaths: new Set(Array.from(folderState.expandedDirectoryPaths)),
            includeFilters: [...folderState.includeFilters],
            excludeFilters: [...folderState.excludeFilters],
            useRegex: folderState.useRegex,
            includeProjectTree: folderState.includeProjectTree,
            folderSummaryThreshold: folderState.folderSummaryThreshold,
            maxSelectionCount: folderState.maxSelectionCount,
            lastActiveTab: folderState.lastActiveTab,
          };
        }),

      setSelectedFiles: (selectedFiles: ReadonlySet<string>) =>
        set({ selectedFilePaths: new Set(selectedFiles) }),

      addSelectedFile: (folderId: string, path: string) =>
        set((state) => {
          if (state.selectedFilePaths.size >= state.maxSelectionCount) {
            return state;
          }
          const compositeKey = encodeFileSelection(folderId, path);
          const newSelected = new Set(state.selectedFilePaths);
          newSelected.add(compositeKey);
          return { selectedFilePaths: newSelected };
        }),

      removeSelectedFile: (folderId: string, path: string) =>
        set((state) => {
          const compositeKey = encodeFileSelection(folderId, path);
          const newSet = new Set(state.selectedFilePaths);
          newSet.delete(compositeKey);
          return { selectedFilePaths: newSet };
        }),

      toggleSelectedFile: (folderId: string, path: string) =>
        set((state) => {
          const compositeKey = encodeFileSelection(folderId, path);
          const newSet = new Set(state.selectedFilePaths);
          if (newSet.has(compositeKey)) {
            newSet.delete(compositeKey);
          } else if (state.selectedFilePaths.size < state.maxSelectionCount) {
            newSet.add(compositeKey);
          }
          return { selectedFilePaths: newSet };
        }),

      clearSelectedFiles: () => set({ selectedFilePaths: new Set<string>() }),

      setExpandedPaths: (paths: ReadonlySet<string>) =>
        set({ expandedDirectoryPaths: new Set(paths) }),

      toggleDirectoryExpansion: (path: string) =>
        set((state) => {
          const newSet = new Set(state.expandedDirectoryPaths);
          if (newSet.has(path)) {
            newSet.delete(path);
          } else {
            newSet.add(path);
          }
          return { expandedDirectoryPaths: newSet };
        }),

      setFilters: (include: readonly string[], exclude: readonly string[]) =>
        set({ includeFilters: [...include], excludeFilters: [...exclude] }),

      setUseRegex: (useRegex: boolean) => set({ useRegex }),

      setIncludeProjectTree: (value: boolean) => set({ includeProjectTree: value }),

      setFolderSummaryThreshold: (value: number) =>
        set((state) => {
          if (value < 0) return state;
          return { folderSummaryThreshold: value };
        }),

      setMaxSelectionCount: (count: number) =>
        set((state) => {
          if (count < 1) return state;
          return { maxSelectionCount: count };
        }),

      setLastActiveTab: (tab: string) => set({ lastActiveTab: tab }),

      // New actions for expand all and collapse all directories
      expandAllDirectories: (fileTree: import('@/lib/file/types').IFileNode[]) =>
        set((state) => {
          const newExpandedPaths = new Set(state.expandedDirectoryPaths);
          const traverse = (nodes: import('@/lib/file/types').IFileNode[]) => {
            for (const node of nodes) {
              if (node.type === 'directory') {
                newExpandedPaths.add(node.path);
                if (node.children && node.children.length > 0) {
                  traverse(node.children);
                }
              }
            }
          };
          traverse(fileTree);
          return { expandedDirectoryPaths: newExpandedPaths };
        }),

      collapseAllDirectories: () => set({ expandedDirectoryPaths: new Set() }),
    }),
    createPersistOptions()
  )
);
