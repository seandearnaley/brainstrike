import { DatabaseDemoPanel } from '@brainstrike/db-explorer';
import type { QueueAdapter } from '@brainstrike/queue';
import type React from 'react';

type DatabaseTabProps = {
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
   * 4. DatabaseTab → DatabaseDemoPanel
   *
   * MUST be passed through to child components! If not passed:
   * - Import operations will use the wrong queue instance
   */
  embeddingQueue?: QueueAdapter | null;
};

/**
 * Database tab chunk component showing database demo panel.
 *
 * IMPORTANT: This component MUST forward the embeddingQueue prop to DatabaseDemoPanel.
 * The queue is created at the app level and needs to be shared across import operations.
 */
export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pass embeddingQueue to DatabaseDemoPanel for import operations */}
      <DatabaseDemoPanel embeddingQueue={embeddingQueue} />
    </div>
  );
}
