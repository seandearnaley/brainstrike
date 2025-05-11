/**
 * File Explorer Store
 *
 * This store manages the state of the file explorer, including selected files, expanded directories,
 * and folder-specific states. It uses Zustand with persistence to maintain state across page reloads.
 *
 * Action logic is delegated to separate action creator functions imported from ./actions/*.
 */

import type { FileExplorerState } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types';
import { type StateCreator, create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDirectoryExpansionActions } from './actions/directory-expansion-actions';
import { createFileSelectionActions } from './actions/file-selection-actions';
import { createFolderStateActions } from './actions/folder-state-actions';
import { createSettingsActions } from './actions/settings-actions';
import { createPersistOptions } from './persistence/file-explorer-persistence';

// Explicitly type the state creator function
const stateCreator: StateCreator<FileExplorerState, [['zustand/persist', unknown]], []> = (
  set,
  get
) => {
  const initialData = {
    // Initial state properties from DEFAULT_STATE
    ...DEFAULT_STATE,
    // Ensure lastActiveTab is explicitly set from DEFAULT_STATE or provide default
    lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files',
    // Initialize/Override specific state parts as needed
    currentFolderId: null,
    folderStates: {},
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
  };

  const actions = {
    ...createFolderStateActions(set, get),
    ...createFileSelectionActions(set, get),
    ...createDirectoryExpansionActions(set, get),
    ...createSettingsActions(set, get),
  };

  // Combine data and actions. Type assertion might be needed if inference fails.
  return {
    ...initialData,
    ...actions,
  } as FileExplorerState;
};

export const useFileExplorerStore = create<FileExplorerState>()(
  persist(stateCreator, createPersistOptions())
);
