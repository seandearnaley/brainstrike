import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the Git surface (and its @codemirror/merge dependency) so it only
// loads when the desktop user opens the Git tab. The wrapper is rendered only
// when `window.git` is present (see root-layout-content.tsx capability gate), so
// there is no isElectron check here.
const GitPanel = lazy(() =>
  import('@brainstrike/app-shell/git-panel').then((module) => ({ default: module.GitPanel }))
);

export default function GitPageContent(): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Loading Git…
        </div>
      }
    >
      <GitPanel />
    </Suspense>
  );
}
