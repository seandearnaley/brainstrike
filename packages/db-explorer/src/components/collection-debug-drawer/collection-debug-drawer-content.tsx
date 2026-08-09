/**
 * Lazily-mounted body of the collection debug drawer.
 *
 * Default-exported for `React.lazy`: everything expensive the drawer needs —
 * the retrieval executor, the coverage live query, the node inspector — is
 * reachable only through this module, so a collapsed drawer never loads it.
 */

import type { ContextTarget } from '@brainstrike/context-actions';
import { ActionContextMenu, useContextMenuTarget } from '@brainstrike/ui';
import { useCallback, useRef } from 'react';
import { ChunkInspectorSection } from './chunk-inspector-section';
import type { CollectionDebugDrawerProps } from './drawer-props';
import { FailedEmbeddingsSection } from './failed-embeddings-section';
import { RetrievalPreviewSection } from './retrieval-preview-section';

export default function CollectionDebugDrawerContent({
  activeCollectionId,
  activeCollectionSystemRole,
  chunkRepository,
  database,
  fileRepository,
  recordPagination,
  records,
}: CollectionDebugDrawerProps) {
  const controller = useContextMenuTarget();
  const { setTarget } = controller;
  const originRef = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);

  /**
   * Claim the right-clicked row synchronously during the contextmenu event and
   * remember the exact origin element so focus can return to it.
   */
  const handleClaimTarget = useCallback(
    (target: ContextTarget, element: HTMLElement) => {
      originRef.current = element;
      setTarget(target);
    },
    [setTarget]
  );

  /**
   * Radix would otherwise restore focus to the trigger on a delay. Return it to
   * the exact origin row when that row is still mounted, and to the drawer body
   * otherwise — never leave focus on `body`.
   */
  const handleCloseAutoFocus = useCallback(() => {
    const origin = originRef.current;
    if (origin?.isConnected) {
      origin.focus();
      return;
    }
    fallbackRef.current?.focus();
  }, []);

  return (
    <ActionContextMenu controller={controller} onCloseAutoFocus={handleCloseAutoFocus}>
      <div
        className="@container/debug-drawer flex min-h-0 flex-col overflow-y-auto focus-visible:outline-none"
        data-testid="collection-debug-drawer-content"
        onContextMenuCapture={() => setTarget(null)}
        ref={fallbackRef}
        tabIndex={-1}
      >
        <ChunkInspectorSection
          activeCollectionId={activeCollectionId}
          database={database}
          onClaimTarget={handleClaimTarget}
          recordPagination={recordPagination}
          records={records}
        />
        <RetrievalPreviewSection
          activeCollectionId={activeCollectionId}
          activeCollectionSystemRole={activeCollectionSystemRole}
          chunkRepository={chunkRepository}
          fileRepository={fileRepository}
          onClaimTarget={handleClaimTarget}
        />
        <FailedEmbeddingsSection
          activeCollectionId={activeCollectionId}
          database={database}
          onClaimTarget={handleClaimTarget}
        />
      </div>
    </ActionContextMenu>
  );
}
