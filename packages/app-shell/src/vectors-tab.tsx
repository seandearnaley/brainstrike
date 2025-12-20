import type { QueueAdapter } from '@brainstrike/queue';
import React, { lazy, type ReactElement } from 'react';

const VectorsTabChunk = lazy(async () => ({
  default: (await import('./vectors-tab-chunk')).VectorsTab,
}));

type VectorsTabProps = {
  readonly embeddingQueue?: QueueAdapter | null;
};

export function VectorsTab({ embeddingQueue = null }: VectorsTabProps): ReactElement {
  return (
    <React.Suspense fallback={<div className="px-2 text-xs opacity-70">Loading vectors...</div>}>
      <VectorsTabChunk embeddingQueue={embeddingQueue} />
    </React.Suspense>
  );
}
