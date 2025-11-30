import type { QueueAdapter } from '@brainstrike/queue';
import React, { lazy, type ReactElement } from 'react';

const DatabaseTabChunk = lazy(async () => ({
  default: (await import('./database-tab-chunk')).DatabaseTab,
}));

type DatabaseTabProps = {
  readonly embeddingQueue?: QueueAdapter | null;
};

export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): ReactElement {
  return (
    <React.Suspense fallback={<div className="px-2 text-xs opacity-70">Loading DB UI…</div>}>
      <DatabaseTabChunk embeddingQueue={embeddingQueue} />
    </React.Suspense>
  );
}
