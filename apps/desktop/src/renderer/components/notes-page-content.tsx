import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the notes vault surface so it only loads when the Notes tab is
// opened. The wrapper is rendered only when the File System Access directory
// picker exists (see root-layout-content.tsx capability gate).
const NotesVaultPanel = lazy(() =>
  import('@brainstrike/notes-vault/panel').then((module) => ({
    default: module.NotesVaultPanel,
  }))
);

export default function NotesPageContent(): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Loading Notes…
        </div>
      }
    >
      <NotesVaultPanel />
    </Suspense>
  );
}
