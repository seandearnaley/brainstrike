import { ContextExplorerAppBody } from '@brainstrike/file-explorer-ui/shell';
import { Suspense } from 'react';

/**
 * Context explorer page content — the middle panel of the route-local explorer layout.
 * Hosts the workspace tab strip: a pinned Context Explorer app plus any open file tabs.
 * The TokenCacheProvider in root-layout-content.tsx wraps the entire layout so this
 * component and the left panel share the same token cache context.
 *
 * This surface stays mounted once visited (`mountedTabs` in
 * packages/app-shell/src/root-layout-content.tsx), so it must NOT write document
 * metadata — `useDocumentTitle` owns the title/description for every route.
 */
export default function ContextExplorerPageContent() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center">Loading...</div>}>
      <ContextExplorerAppBody />
    </Suspense>
  );
}
