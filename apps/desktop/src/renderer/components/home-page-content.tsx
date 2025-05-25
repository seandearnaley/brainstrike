import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { FileExplorer } from '@brainstrike/file-explorer-ui';
import { Suspense } from 'react';
import { Helmet } from 'react-helmet-async';

// Desktop file explorer component
function DesktopFileExplorer() {
  const { storageAdapter } = useAdapters();

  return (
    <FileExplorerProvider storageAdapter={storageAdapter}>
      <FileExplorer />
    </FileExplorerProvider>
  );
}

export default function HomePageContent() {
  return (
    <>
      <Helmet>
        <title>BrainStrike Desktop - Home</title>
        <meta name="description" content="BrainStrike Desktop Home Dashboard" />
      </Helmet>
      <Suspense
        fallback={<div className="flex items-center justify-center h-full">Loading...</div>}
      >
        <DesktopFileExplorer />
      </Suspense>
    </>
  );
}
