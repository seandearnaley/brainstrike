import {
  FileExplorerLeftPanel,
  FileExplorerMiddlePanelTabbed,
} from '@brainstrike/file-explorer-ui';
import { Suspense } from 'react';

// Desktop file explorer component
function DesktopFileExplorer() {
  return <FileExplorerMiddlePanelTabbed />;
}

// Desktop file explorer left panel component
function DesktopFileExplorerLeftPanel() {
  return <FileExplorerLeftPanel />;
}

export default function HomePageContent() {
  return (
    <>
      <title>BrainStrike Desktop - Home</title>
      <meta content="BrainStrike Desktop Home Dashboard" name="description" />
      <Suspense
        fallback={<div className="flex h-full items-center justify-center">Loading...</div>}
      >
        <DesktopFileExplorer />
      </Suspense>
    </>
  );
}

export { DesktopFileExplorerLeftPanel };
