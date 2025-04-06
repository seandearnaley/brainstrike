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
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDirectoryExpansionActions } from './actions/directory-expansion-actions';
import { createFileSelectionActions } from './actions/file-selection-actions';
import { createFolderStateActions } from './actions/folder-state-actions';
import { createSettingsActions } from './actions/settings-actions';
import { createPersistOptions } from './persistence/file-explorer-persistence';

export const useFileExplorerStore = create<FileExplorerState>()(
  persist(
    (set, get) => ({
      // Initial state properties from DEFAULT_STATE
      ...DEFAULT_STATE, // Spread default state values first

      // Initialize/Override specific state parts as needed
      currentFolderId: null, // Add missing property
      folderStates: {}, // Start with empty folder states map
      selectedFilePaths: new Set<string>(), // Initialize as empty Set
      expandedDirectoryPaths: new Set<string>(), // Initialize as empty Set

      // Actions (delegated to creators)
      ...createFolderStateActions(set, get),
      ...createFileSelectionActions(set, get),
      ...createDirectoryExpansionActions(set, get),
      ...createSettingsActions(set, get),
    }),
    createPersistOptions() // Persistence configuration
  )
);
