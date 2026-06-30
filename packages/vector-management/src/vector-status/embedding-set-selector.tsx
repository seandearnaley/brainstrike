import type { DbHandle } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { useCallback } from 'react';
import { CollectionSelect } from '../collection-select/collection-select.js';

/**
 * Hook to manage embedding set selection state via Zustand store.
 * Provides a reactive way to read and update the active embedding set ID.
 */
export function useEmbeddingSetSelection() {
  const selectedId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const setActiveEmbeddingSetId = useVectorStatusUIStore((s) => s.setActiveEmbeddingSetId);

  const setSelectedId = useCallback(
    (id: string | null) => {
      setActiveEmbeddingSetId(id);
    },
    [setActiveEmbeddingSetId]
  );

  return { selectedId, setSelectedId };
}

export interface EmbeddingSetSelectorProps {
  /**
   * Database instance for querying embedding sets
   */
  db: DbHandle | null;

  /**
   * Callback when selection changes
   */
  onSelectionChange: (id: string | null) => void;

  /**
   * Currently selected embedding set ID
   */
  selectedId: string | null;
}

/**
 * EmbeddingSetSelector - Compact dropdown for selecting embedding sets in Vector Status
 *
 * This is a thin wrapper around CollectionSelect configured for the compact
 * Vector Status panel. For the full-featured version with labels and actions,
 * see SearchCollectionSelector in db-explorer.
 */
export function EmbeddingSetSelector({
  db,
  selectedId,
  onSelectionChange,
}: EmbeddingSetSelectorProps) {
  return (
    <CollectionSelect
      db={db}
      emptyState={
        <div className="rounded border border-dashed p-2 text-center text-muted-foreground text-xs">
          No embedding sets yet
        </div>
      }
      onSelectionChange={onSelectionChange}
      placeholder="Select collection..."
      selectedId={selectedId}
      size="compact"
    />
  );
}
