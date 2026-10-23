import {
  selectIndexConfig,
  useIndexConfigStore,
} from '@brainstrike/app-state/stores/index-config-store';
import { useIndexingActivityStore } from '@brainstrike/app-state/stores/indexing-activity-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { useEffect, useMemo } from 'react';

export function IndexingActivityCoordinator(): null {
  const setBackgroundSnapshot = useIndexingActivityStore((state) => state.setBackgroundSnapshot);
  // Only Main's saved Off turns indexing off; a config not yet read is not off.
  const off = useIndexConfigStore((store) => selectIndexConfig(store)?.mode === 'off');

  const backgroundStatus = useWorkspaceCollectionSyncStatusStore((state) => ({
    lastError: state.lastError,
    managedCollectionId: state.managedCollectionId,
    managedCollectionName: state.managedCollectionName,
    pauseReasons: state.pauseReasons,
    state: state.state,
  }));

  const backgroundSnapshot = useMemo(
    () => ({
      enabled: !off,
      lastError: backgroundStatus.lastError,
      managedCollectionId: backgroundStatus.managedCollectionId,
      managedCollectionName: backgroundStatus.managedCollectionName,
      paused: backgroundStatus.state === 'paused',
      pauseReasons: backgroundStatus.pauseReasons,
      state: backgroundStatus.state,
    }),
    [
      off,
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
