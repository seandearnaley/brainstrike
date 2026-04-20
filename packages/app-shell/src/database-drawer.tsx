import type { QueueAdapter } from '@brainstrike/queue';
import { type ReactElement, useEffect } from 'react';
import { DatabaseTab, preloadDatabaseTab } from './database-tab';

interface DatabaseDrawerProps {
  readonly chunkingMode?: 'host-proxy' | 'local';
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
  readonly preloadDatabaseTabOnMount?: boolean;
}

export function DatabaseDrawer({
  chunkingMode = 'local',
  loadEmbeddingQueue = null,
  preloadDatabaseTabOnMount = false,
}: DatabaseDrawerProps): ReactElement {
  useEffect(() => {
    if (!preloadDatabaseTabOnMount) {
      return;
    }
    void preloadDatabaseTab().catch(() => {
      // Intent preload should not surface as an unhandled rejection during navigation/reload.
    });
  }, [preloadDatabaseTabOnMount]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="database-drawer">
      <DatabaseTab chunkingMode={chunkingMode} loadEmbeddingQueue={loadEmbeddingQueue} />
    </div>
  );
}
