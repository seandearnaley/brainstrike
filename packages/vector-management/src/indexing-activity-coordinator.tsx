import { useIndexingActivityStore } from '@brainstrike/app-state/stores/indexing-activity-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { useEffect, useMemo } from 'react';

export function IndexingActivityCoordinator(): null {
  const setBackgroundSnapshot = useIndexingActivityStore((state) => state.setBackgroundSnapshot);

  const backgroundStatus = useWorkspaceCollectionSyncStatusStore((state) => ({
    lastError: state.lastError,
    managedCollectionId: state.managedCollectionId,
    managedCollectionName: state.managedCollectionName,
    pauseReasons: state.pauseReasons,
    state: state.state,
  }));

  const backgroundSnapshot = useMemo(
    () => ({
      enabled: backgroundStatus.state !== 'disabled',
      lastError: backgroundStatus.lastError,
      managedCollectionId: backgroundStatus.managedCollectionId,
      managedCollectionName: backgroundStatus.managedCollectionName,
      paused: backgroundStatus.state === 'paused',
      pauseReasons: backgroundStatus.pauseReasons,
      state: backgroundStatus.state,
    }),
    [
      backgroundStatus.lastError,
      backgroundStatus.managedCollectionId,
      backgroundStatus.managedCollectionName,
      backgroundStatus.pauseReasons,
      backgroundStatus.state,
    ]
  );

  useEffect(() => {
    setBackgroundSnapshot(backgroundSnapshot);
  }, [backgroundSnapshot, setBackgroundSnapshot]);

  return null;
}
