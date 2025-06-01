import { FileExplorerLeftPanel, FileExplorerMiddlePanel } from '@brainstrike/file-explorer-ui';
import { Suspense } from 'react';
import { Helmet } from 'react-helmet-async';

// Web file explorer component
function WebFileExplorer() {
  return <FileExplorerMiddlePanel />;
}

// Web file explorer left panel component
function WebFileExplorerLeftPanel() {
  return <FileExplorerLeftPanel />;
}

export default function HomePageContent() {
  return (
    <>
      <Helmet>
        <title>BrainStrike.ai - Home</title>
        <meta name="description" content="BrainStrike.ai Home Dashboard" />
      </Helmet>
      <Suspense
        fallback={<div className="flex items-center justify-center h-full">Loading...</div>}
      >
        <WebFileExplorer />
      </Suspense>
    </>
  );
}

export { WebFileExplorerLeftPanel };
