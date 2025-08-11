import { isFileExplorerV2Enabled } from '@brainstrike/app-shell';
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
  const useV2 = isFileExplorerV2Enabled();
  return (
    <div data-testid={useV2 ? 'explorer-v2-enabled' : 'explorer-v2-disabled'}>
      <FileExplorerLeftPanel useV2={useV2} />
    </div>
  );
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
