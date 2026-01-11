import type { QueueAdapter } from '@brainstrike/queue';
import type { ReactElement } from 'react';
import { VectorsTab as VectorsTabChunk } from './vectors-tab-chunk';

interface VectorsTabProps {
  readonly embeddingQueue?: QueueAdapter | null;
}

export function VectorsTab({ embeddingQueue = null }: VectorsTabProps): ReactElement {
  return <VectorsTabChunk embeddingQueue={embeddingQueue} />;
}
