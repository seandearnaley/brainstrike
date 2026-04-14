import { createWithEqualityFn as create } from 'zustand/traditional';

export type WorkspaceCollectionSyncState =
  | 'disabled'
  | 'idle'
  | 'scanning'
  | 'importing'
  | 'embedding'
  | 'error';

export interface WorkspaceCollectionSyncStatusData {
  activeRootPath: string | null;
  currentFilePath: string | null;
  lastError: string | null;
  managedCollectionId: string | null;
  managedCollectionName: string | null;
  processedFiles: number;
  queuedFiles: number;
  state: WorkspaceCollectionSyncState;
}

interface WorkspaceCollectionSyncStatusActions {
  reset: () => void;
  setStatus: (patch: Partial<WorkspaceCollectionSyncStatusData>) => void;
}

export type WorkspaceCollectionSyncStatusStore = WorkspaceCollectionSyncStatusData &
  WorkspaceCollectionSyncStatusActions;

const DEFAULT_STATE: WorkspaceCollectionSyncStatusData = {
  state: 'disabled',
  managedCollectionId: null,
  managedCollectionName: null,
  currentFilePath: null,
  queuedFiles: 0,
  processedFiles: 0,
  lastError: null,
  activeRootPath: null,
};

export const useWorkspaceCollectionSyncStatusStore = create<WorkspaceCollectionSyncStatusStore>()(
  (set) => ({
    ...DEFAULT_STATE,
    setStatus: (patch: Partial<WorkspaceCollectionSyncStatusData>) => set(() => patch),
    reset: () =>
      set({
        ...DEFAULT_STATE,
      }),
  })
);

export function __resetWorkspaceCollectionSyncStatusStoreForTests(): void {
  useWorkspaceCollectionSyncStatusStore.setState({
    ...DEFAULT_STATE,
  });
}
