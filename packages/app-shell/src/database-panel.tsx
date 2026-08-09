import type { QueueAdapter } from '@brainstrike/queue';
import type { ReactElement } from 'react';
import { DatabaseTab } from './database-tab';

interface DatabasePanelProps {
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
}

export function DatabasePanel({ loadEmbeddingQueue = null }: DatabasePanelProps): ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="database-panel">
      <DatabaseTab loadEmbeddingQueue={loadEmbeddingQueue} />
    </div>
  );
}
