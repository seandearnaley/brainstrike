import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the Changes surface (BST-1114) so it only loads when the
// desktop user opens the Changes tab. Mirrors `git-page-content.tsx` exactly:
// the wrapper is rendered only when `window.changes` is present (capability
// gate lives wherever the Changes nav item is wired), so there is no
// `isElectron()` check here.
const ChangesSurface = lazy(() =>
  import('@brainstrike/app-shell/changes').then((m) => ({ default: m.ChangesSurface }))
);

export function ChangesPageContent(): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Loading Changes…
        </div>
      }
    >
      <ChangesSurface />
    </Suspense>
  );
}
