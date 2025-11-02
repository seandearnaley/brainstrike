import { DatabaseDemoPanel } from '@brainstrike/db-explorer';
import type { QueueAdapter } from '@brainstrike/queue';
import { QueueHud, VectorStatusWithDialog } from '@brainstrike/vector-management';
import type React from 'react';

interface DatabaseTabProps {
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
   * 3. RootLayoutContent → RightPanel → DatabaseTab (HERE)
   * 4. DatabaseTab → VectorStatusWithDialog and DatabaseDemoPanel
   *
   * MUST be passed through to child components! If not passed:
   * - VectorStatusWithDialog will create a generic fallback queue
   * - Manage embedding sets button won't work properly
   * - Database operations will use wrong queue instance
   */
  embeddingQueue?: QueueAdapter | null;
}

/**
 * Database tab chunk component showing database demo panel, vector status, and queue HUD.
 *
 * IMPORTANT: This component MUST forward the embeddingQueue prop to VectorStatusWithDialog
 * and DatabaseDemoPanel. The queue is created at the app level and needs to be shared
 * across all embedding operations.
 */
export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): React.ReactElement {
  return (
    <div className="space-y-4">
      {/* Pass embeddingQueue to DatabaseDemoPanel for import operations */}
      <DatabaseDemoPanel embeddingQueue={embeddingQueue} />

      {/* CRITICAL: Pass embeddingQueue to VectorStatusWithDialog as queueAdapter
          This ensures the manage button and embedding operations use the app's queue */}
      <VectorStatusWithDialog queueAdapter={embeddingQueue} />

      <QueueHud />
    </div>
  );
}
