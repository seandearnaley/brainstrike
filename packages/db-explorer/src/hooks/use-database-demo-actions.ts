import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { createLogger } from '@brainstrike/logging';
import { useCallback } from 'react';

const logger = createLogger('DatabaseDemoPanel');

interface UseDatabaseDemoActionsOptions {
  readonly loadChunks: () => Promise<void>;
  readonly loadRecords: () => Promise<void>;
  readonly setActiveCollectionId: (collectionId: string | null) => void;
}

export function useDatabaseDemoActions({
  loadChunks,
  loadRecords,
  setActiveCollectionId,
}: UseDatabaseDemoActionsOptions): {
  handleCollectionChange: (collectionId: string | null) => void;
  handleManualRefresh: () => void;
} {
  const handleCollectionChange = useCallback(
    (collectionId: string | null) => {
      const nextCollection = collectionId
        ? useVectorStatusUIStore
            .getState()
            .cachedCollections.find((collection) => collection.id === collectionId)
        : null;
      if (nextCollection?.systemRole === 'workspace-index') {
        return;
      }
      logger.info('Collection changed', { collectionId });
      setActiveCollectionId(collectionId);
    },
    [setActiveCollectionId]
  );

  const handleManualRefresh = useCallback(() => {
    void Promise.allSettled([loadRecords(), loadChunks()]);
  }, [loadChunks, loadRecords]);

  return { handleCollectionChange, handleManualRefresh };
}
