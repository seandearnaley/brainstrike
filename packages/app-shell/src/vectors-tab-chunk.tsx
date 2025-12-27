import type { QueueAdapter } from '@brainstrike/queue';
import { VectorStatusWithDialog } from '@brainstrike/vector-management';
import type React from 'react';

type VectorsTabProps = {
  /**
   * CRITICAL: The embedding queue from the app layer.
   *
   * This prop originates from:
   * - Desktop: apps/desktop/src/renderer/create-embedding-queue.ts (createElectronEmbeddingQueue)
   * - Web: apps/web/src/create-embedding-queue.ts (createBrowserEmbeddingQueue)
   *
   * Flow path:
   * 1. App creates queue: createElectronEmbeddingQueue() or createBrowserEmbeddingQueue()
   * 2. Passed to RootLayoutContent as embeddingQueue prop
   * 3. RootLayoutContent -> ToolsPanel -> VectorsTab (HERE)
   * 4. VectorsTab -> VectorStatusWithDialog
   *
   * MUST be passed through to child components! If not passed:
   * - VectorStatusWithDialog will create a generic fallback queue
   * - Manage embedding sets button won't work properly
   * - Database operations will use wrong queue instance
   */
  embeddingQueue?: QueueAdapter | null;
};

/**
 * Vectors tab chunk component showing vector status and embedding management controls.
 */
export function VectorsTab({ embeddingQueue = null }: VectorsTabProps): React.ReactElement {
  return (
    <div className="flex h-full flex-col space-y-3 px-4 py-3">
      <div className="text-muted-foreground text-xs">
        Manage embedding sets, worker status, and queue health for your active collections.
      </div>
      <VectorStatusWithDialog queueAdapter={embeddingQueue} />
    </div>
  );
}
