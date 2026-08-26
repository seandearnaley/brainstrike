import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the Worktree Map (BST-1392) so it only loads when the desktop
// user opens the Worktrees tab. Mirrors `changes-page-content.tsx`: the
// wrapper is rendered only when `window.worktrees` is present (the capability
// gate lives where the tab is wired), so there is no runtime-mode check here.
const WorktreeMapSurface = lazy(() =>
  import('@brainstrike/app-shell/worktree-map').then((m) => ({ default: m.WorktreeMapSurface }))
);

export function WorktreeMapPageContent(): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Loading Worktrees…
        </div>
      }
    >
      <WorktreeMapSurface />
    </Suspense>
  );
}
