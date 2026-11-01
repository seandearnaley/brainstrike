/**
 * File Explorer Store
 *
 * This store manages the state of the file explorer, including selected files, expanded directories,
 * and folder-specific states. It uses Zustand with persistence to maintain state across page reloads.
 *
 * Action logic is delegated to separate action creator functions imported from ./actions/*.
 */

import { persistDurable } from '@brainstrike/storage';
import type { FileExplorerState, PersistenceRecoveryNotice } from '@brainstrike/types';
import { DEFAULT_STATE } from '@brainstrike/types';
import type { StateCreator } from 'zustand';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createActiveRootActions } from './actions/active-root-actions';
import { createDirectoryExpansionActions } from './actions/directory-expansion-actions';
import { createFileContentActions, createFileContentCache } from './actions/file-content-actions';
import { createFileSelectionActions } from './actions/file-selection-actions';
import { createFolderStateActions } from './actions/folder-state-actions';
import { createSelectionModelActions } from './actions/selection-model-actions';
import { createSettingsActions } from './actions/settings-actions';
import {
  createPersistOptions,
  hydrateFileExplorerStore,
} from './persistence/file-explorer-persistence';
import { FILE_EXPLORER_STORAGE_KEY } from './persistence/persistence-constants';

// Explicitly type the state creator function
const stateCreator: StateCreator<FileExplorerState, [['zustand/persist', unknown]], []> = (
  set,
  get
) => {
  // The volatile LRU is part of this store's runtime state. Creating it inside
  // the StateCreator invocation gives every bound/vanilla store one cache and
  // prevents retired providers from mutating a replacement store's reads.
  const fileContentCache = createFileContentCache();
  const initialData = {
    // Initial state properties from DEFAULT_STATE
    ...DEFAULT_STATE,
    // Multi-root (Phase 4) initial state
    activeRootIds: [] as string[],
    // Initialize/Override specific state parts as needed
    currentFolderId: null,
    expandedDirectoryPaths: new Set<string>(),
    folderAccessOrder: [],
    folderStates: {},
    // Ephemeral access loading state (not persisted)
    isAccessLoading: false,
    // Ensure lastActiveTab is explicitly set from DEFAULT_STATE or provide default
    lastActiveTab: DEFAULT_STATE.lastActiveTab ?? 'files',
    // Ephemeral recovery signal (not persisted)
    persistenceRecoveryNotice: null,
    quickFilter: '',
    rootDescriptors: {} as FileExplorerState['rootDescriptors'],
    selectedFilePaths: new Set<string>(),
  };

  const actions = {
    ...createFolderStateActions(set, get),
    ...createFileSelectionActions(set, get),
    ...createDirectoryExpansionActions(set, get),
    ...createSettingsActions(set, get),
    ...createFileContentActions(set, get, fileContentCache),
    ...createSelectionModelActions(set),
    ...createActiveRootActions(set, get),
    clearQuickFilter: () => {
      set({ quickFilter: '' });
    },
    consumePersistenceRecoveryNotice: () => {
      let consumed = false;
      set((state) => {
        if (state.persistenceRecoveryNotice === null) {
          return state;
        }
        consumed = true;
        return { persistenceRecoveryNotice: null };
      });
      return consumed;
    },
    reportPersistedStateDiscard: (
      notice: PersistenceRecoveryNotice = 'persisted-state-discarded'
    ) => {
      set({ persistenceRecoveryNotice: notice });
    },
    setDevInlineFixtureEnabled: (value: boolean) => {
      set({ devInlineFixtureEnabled: value });
    },
    setExplorerScrollTop: (value: number) => {
      // Clamp negatives to 0; a persisted negative offset would fight the
      // browser's own clamp and produce a one-frame jump on restore.
      set({ explorerScrollTop: Math.max(value, 0) });
    },
    setFilterChipsVisible: (visible: boolean) => {
      set({ isFilterChipsVisible: visible });
    },
    setFiltersExpanded: (expanded: boolean) => {
      set({ isFiltersExpanded: expanded });
    },
    setIsAccessLoading: (loading: boolean) => {
      set({ isAccessLoading: loading });
    },
    setQuickFilter: (value: string) => {
      set({ quickFilter: value });
    },
  };

  // Combine data and actions. Type assertion might be needed if inference fails.
  return {
    ...initialData,
    ...actions,
  } as FileExplorerState;
};

/** A store whose view state persists (`persistDurable`), read as it is made. */
export function createFileExplorerStore() {
  return hydrateFileExplorerStore(
    create<FileExplorerState>()(
      persistDurable(FILE_EXPLORER_STORAGE_KEY, stateCreator, createPersistOptions())
    )
  );
}

export { stateCreator };
