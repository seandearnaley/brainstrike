import {
  FileExplorerLeftPanel,
  FileExplorerMiddlePanelTabbed,
} from '@brainstrike/file-explorer-ui';
import { Suspense } from 'react';
import { Helmet } from 'react-helmet-async';

// Web file explorer component
function WebFileExplorer() {
  return <FileExplorerMiddlePanelTabbed />;
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
        <meta content="BrainStrike.ai Home Dashboard" name="description" />
      </Helmet>
      <Suspense
        fallback={<div className="flex h-full items-center justify-center">Loading...</div>}
      >
        <WebFileExplorer />
      </Suspense>
    </>
  );
}

export { WebFileExplorerLeftPanel };
