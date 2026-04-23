import { FileExplorerMiddlePanelTabbed } from '@brainstrike/file-explorer-ui';
import { Suspense } from 'react';
import { Helmet } from 'react-helmet-async';

/**
 * Context explorer page content - the middle panel of the route-local explorer layout.
 * Note: TokenCacheProvider wraps the entire layout in root-layout-content.tsx,
 * so this component (and the left panel) share the same token cache context.
 */
export default function ContextExplorerPageContent() {
  return (
    <>
      <Helmet>
        <title>BrainStrike.ai - Home</title>
        <meta content="BrainStrike.ai Home Dashboard" name="description" />
      </Helmet>
      <Suspense
        fallback={<div className="flex h-full items-center justify-center">Loading...</div>}
      >
        <FileExplorerMiddlePanelTabbed />
      </Suspense>
    </>
  );
}
