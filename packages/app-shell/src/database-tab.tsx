import type { QueueAdapter } from '@brainstrike/queue';
import type { ReactElement } from 'react';
import { DatabaseTab as DatabaseTabContent } from './database-tab-chunk';

interface DatabaseTabProps {
  readonly embeddingQueue?: QueueAdapter | null;
}

export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): ReactElement {
  return <DatabaseTabContent embeddingQueue={embeddingQueue} />;
}
