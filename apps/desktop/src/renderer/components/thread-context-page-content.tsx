import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the thread context map (ADR-0021) so it loads only when the
// Context tab opens, as the Changes surface does.
const ThreadContextPage = lazy(() =>
  import('@brainstrike/app-shell/context-map').then((m) => ({ default: m.ThreadContextPage }))
);

export function ThreadContextPageContent(): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
          Loading Context…
        </div>
      }
    >
      <ThreadContextPage />
    </Suspense>
  );
}
