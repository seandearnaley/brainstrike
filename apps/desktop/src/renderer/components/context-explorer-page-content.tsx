import { ContextExplorerAppBody } from '@brainstrike/file-explorer-ui/shell';
import { Suspense } from 'react';

function DesktopContextExplorerPage() {
  return <ContextExplorerAppBody />;
}

export default function ContextExplorerPageContent() {
  return (
    <>
      <title>BrainStrike Desktop - Home</title>
      <meta content="BrainStrike Desktop Home Dashboard" name="description" />
      <Suspense
        fallback={<div className="flex h-full items-center justify-center">Loading...</div>}
      >
        <DesktopContextExplorerPage />
      </Suspense>
    </>
  );
}
