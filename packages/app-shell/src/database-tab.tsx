import type { QueueAdapter } from '@brainstrike/queue';
import React, { lazy, type ReactElement } from 'react';

const DatabaseTabChunk = lazy(async () => ({
  default: (await import('./database-tab-chunk')).DatabaseTab,
}));

interface DatabaseTabProps {
  readonly embeddingQueue?: QueueAdapter | null;
}

export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): ReactElement {
  return (
    <React.Suspense fallback={<div className="text-xs opacity-70 px-2">Loading DB UI…</div>}>
      <DatabaseTabChunk embeddingQueue={embeddingQueue} />
    </React.Suspense>
  );
}
