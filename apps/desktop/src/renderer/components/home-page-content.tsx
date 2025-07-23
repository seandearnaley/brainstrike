import {
  FileExplorerLeftPanel,
  FileExplorerMiddlePanelTabbed,
} from '@brainstrike/file-explorer-ui';
import { Suspense, useEffect } from 'react';

// Desktop file explorer component
function DesktopFileExplorer() {
  useEffect(() => {
    console.log('[Desktop] DesktopFileExplorer mounted');
    return () => {
      console.log('[Desktop] DesktopFileExplorer unmounted');
    };
  }, []);
  
  return <FileExplorerMiddlePanelTabbed />;
}

// Desktop file explorer left panel component
function DesktopFileExplorerLeftPanel() {
  useEffect(() => {
    console.log('[Desktop] DesktopFileExplorerLeftPanel mounted');
    return () => {
      console.log('[Desktop] DesktopFileExplorerLeftPanel unmounted');
    };
  }, []);
  
  return <FileExplorerLeftPanel />;
}

export default function HomePageContent() {
  console.log('[Desktop] HomePageContent rendering');
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
