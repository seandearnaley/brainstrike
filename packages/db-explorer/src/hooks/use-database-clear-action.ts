import type { useClearAllData } from '@brainstrike/db/react';
import type { useToast } from '@brainstrike/ui';
import { useCallback } from 'react';
import type { useDatabaseErrorBoundary } from './use-database-error-boundary';

interface UseDatabaseClearActionOptions {
  readonly clearAllData: ReturnType<typeof useClearAllData>;
  readonly errorBoundary: ReturnType<typeof useDatabaseErrorBoundary>;
  readonly loadChunks: () => Promise<void>;
  readonly loadRecords: () => Promise<void>;
  readonly onDatabaseCleared: (() => void) | null;
  readonly setClearing: (clearing: boolean) => void;
  readonly setShowClearDialog: (show: boolean) => void;
  readonly toast: ReturnType<typeof useToast>['toast'];
}

export function useDatabaseClearAction({
  clearAllData,
  errorBoundary,
  loadChunks,
  loadRecords,
  onDatabaseCleared,
  setClearing,
  setShowClearDialog,
  toast,
}: UseDatabaseClearActionOptions): () => Promise<void> {
  return useCallback(async () => {
    if (!clearAllData) {
      toast({
        description: 'Database clear functionality is not ready.',
        title: 'Clear Function Not Available',
        variant: 'destructive',
      });
      return;
    }
    if (!onDatabaseCleared) {
      toast({
        description: 'Post-clear application state reset is not ready.',
        title: 'Clear Function Not Available',
        variant: 'destructive',
      });
      return;
    }

    setShowClearDialog(false);
    await errorBoundary.executeMultipleOperations(
      [
        {
          critical: true,
          name: 'Clear Database',
          operation: async () => {
            const result = await clearAllData();
            onDatabaseCleared();
            return result;
          },
        },
        {
          critical: false,
          name: 'Reload File Records',
          operation: async () => {
            await loadRecords();
            return { deletedChunks: 0, deletedFiles: 0 };
          },
        },
        {
          critical: false,
          name: 'Reload Chunks',
          operation: async () => {
            await loadChunks();
            return { deletedChunks: 0, deletedFiles: 0 };
          },
        },
      ],
      setClearing,
      {
        partialSuccessMessage: 'The database was cleared but some data reload operations failed',
        partialSuccessTitle: 'Database Cleared',
        successMessage: 'The database has been cleared and collection data reloaded successfully',
        successTitle: 'Database Cleared',
      }
    );
  }, [
    clearAllData,
    errorBoundary,
    loadChunks,
    loadRecords,
    onDatabaseCleared,
    setClearing,
    setShowClearDialog,
    toast,
  ]);
}
