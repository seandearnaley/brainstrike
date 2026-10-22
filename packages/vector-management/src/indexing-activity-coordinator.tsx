import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { useIndexingActivityStore } from '@brainstrike/app-state/stores/indexing-activity-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { useEffect, useMemo } from 'react';

export function IndexingActivityCoordinator(): null {
  const setBackgroundSnapshot = useIndexingActivityStore((state) => state.setBackgroundSnapshot);

  const backgroundEnabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const backgroundPaused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const configuredManagedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const backgroundStatus = useWorkspaceCollectionSyncStatusStore((state) => ({
    lastError: state.lastError,
    managedCollectionId: state.managedCollectionId,
    managedCollectionName: state.managedCollectionName,
    pauseReasons: state.pauseReasons,
    state: state.state,
  }));

  const managedCollectionId =
    backgroundStatus.managedCollectionId ?? configuredManagedCollectionId ?? null;

  const backgroundSnapshot = useMemo(
    () => ({
      enabled: backgroundEnabled,
      lastError: backgroundStatus.lastError,
      managedCollectionId,
      managedCollectionName: backgroundStatus.managedCollectionName,
      paused: backgroundPaused || backgroundStatus.state === 'paused',
      pauseReasons: backgroundStatus.pauseReasons,
      state: backgroundStatus.state,
    }),
    [
      backgroundEnabled,
      backgroundStatus.lastError,
      backgroundPaused,
      backgroundStatus.managedCollectionName,
      backgroundStatus.pauseReasons,
      backgroundStatus.state,
      managedCollectionId,
    ]
  );

  useEffect(() => {
    setBackgroundSnapshot(backgroundSnapshot);
  }, [backgroundSnapshot, setBackgroundSnapshot]);

  return null;
}
