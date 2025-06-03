import { FileExplorerLeftPanel, FileExplorerMiddlePanel } from '@brainstrike/file-explorer-ui';
import { Suspense } from 'react';

// Desktop file explorer component
function DesktopFileExplorer() {
  return <FileExplorerMiddlePanel />;
}

// Desktop file explorer left panel component
function DesktopFileExplorerLeftPanel() {
  return <FileExplorerLeftPanel />;
}

export default function HomePageContent() {
  return (
    <>
      <title>BrainStrike Desktop - Home</title>
      <meta name="description" content="BrainStrike Desktop Home Dashboard" />
      <Suspense
        fallback={<div className="flex items-center justify-center h-full">Loading...</div>}
      >
        <DesktopFileExplorer />
      </Suspense>
    </>
  );
}

export { DesktopFileExplorerLeftPanel };
