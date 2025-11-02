import { EmbeddingSetsRepository, usePGliteDatabase } from '@brainstrike/db';
import type { QueueAdapter } from '@brainstrike/queue';
import { useMemo, useState } from 'react';
import { ManageEmbeddingSetsDialog } from './embedding-set-management';
import { VectorStatusWithDb } from './vector-status';

export interface VectorStatusWithDialogProps {
  /**
   * CRITICAL: The embedding queue adapter from the app layer.
   *
   * This prop MUST be passed through from:
   * - apps/desktop/src/renderer/components/root-layout-content.tsx (embeddingQueue)
   * - apps/web/src/app/root-layout-content.tsx (embeddingQueue)
   *
   * Flow: Desktop/Web App → RootLayoutContent → RightPanel → DatabaseTab →
   *       DatabaseTabChunk → VectorStatusWithDialog (HERE) → VectorStatusWithDb
   *
   * DO NOT remove this prop! The embedding queue is created at the app level
   * (web: createBrowserEmbeddingQueue, desktop: createElectronEmbeddingQueue)
   * and MUST be passed down so VectorStatus can use the same queue instance
   * for embedding operations.
   *
   * Without this prop, VectorStatusWithDb will create its own generic queue,
   * breaking the integration with the app's embedding system.
   */
  queueAdapter?: QueueAdapter | null;
}

/**
 * Wrapper component that adds the ManageEmbeddingSetsDialog to VectorStatusWithDb.
 * This is separated to avoid circular dependency issues with @brainstrike/db imports.
 *
 * IMPORTANT: This component must forward the queueAdapter prop to VectorStatusWithDb.
 * See VectorStatusWithDialogProps.queueAdapter documentation for critical context.
 */
export function VectorStatusWithDialog({ queueAdapter = null }: VectorStatusWithDialogProps = {}) {
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const db = usePGliteDatabase();
  const repository = useMemo(() => (db ? new EmbeddingSetsRepository(db as never) : null), [db]);

  const handleManageClick = () => {
    setManageDialogOpen(true);
  };

  return (
    <>
      <VectorStatusWithDb queueAdapter={queueAdapter} onManageEmbeddingSets={handleManageClick} />
      {/* Dialog will only mount when opened */}
      {manageDialogOpen && (
        <ManageEmbeddingSetsDialog
          open={manageDialogOpen}
          onOpenChange={setManageDialogOpen}
          db={db as never}
          repository={repository}
          onSetSelected={() => {
            setManageDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
