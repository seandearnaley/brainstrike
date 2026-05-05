import { WorkspaceTabHost } from '@brainstrike/file-explorer-ui';
import { Suspense } from 'react';
import { Helmet } from 'react-helmet-async';

/**
 * Context explorer page content — the middle panel of the route-local explorer layout.
 * Hosts the workspace tab strip: a pinned Context Explorer app plus any open file tabs.
 * The TokenCacheProvider in root-layout-content.tsx wraps the entire layout so this
 * component and the left panel share the same token cache context.
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
        <WorkspaceTabHost className="h-full" />
      </Suspense>
    </>
  );
}
