import type { IndexChunkBoundsCapability } from '@brainstrike/indexing-contract/indexer-client';
import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the thread context map (ADR-0021) so it loads only when the
// Context tab opens, as the Changes surface does.
const ThreadContextPage = lazy(() =>
  import('@brainstrike/app-shell/context-map').then((m) => ({ default: m.ThreadContextPage }))
);

export function ThreadContextPageContent({
  chunkBounds,
}: {
  readonly chunkBounds: IndexChunkBoundsCapability | null;
}): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Loading Context…
        </div>
      }
    >
      <ThreadContextPage chunkBounds={chunkBounds} />
    </Suspense>
  );
}
