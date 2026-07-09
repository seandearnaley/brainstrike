import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';
import {
  COLLECTION_STATS_QUERY,
  type CollectionStatsRow,
  resolveEffectiveStatsRow,
} from './collection-stats-query';

export interface SearchCollectionPickerProps {
  onCollectionChange?: (id: string) => void;
}

/**
 * Embedding-set picker for workspace search. With only the managed
 * workspace-index set present, renders quiet text (no combobox — there is
 * nothing to choose). With 2+ sets, renders a select; the workspace-index
 * row carries a "Managed" badge.
 */
export function SearchCollectionPicker({ onCollectionChange }: SearchCollectionPickerProps) {
  const collectionId = useWorkspaceSearchStore((state) => state.collectionId);
  const setCollectionId = useWorkspaceSearchStore((state) => state.setCollectionId);

  const { rows } = usePGliteLiveQuery<CollectionStatsRow>({
    cacheKey: makeLiveQueryKey('workspace-search-collection-stats'),
    key: 'id',
    mode: 'incremental',
    query: COLLECTION_STATS_QUERY,
  });

  const effectiveId = useMemo(
    () => resolveEffectiveStatsRow(rows, collectionId)?.id ?? '',
    [rows, collectionId]
  );

  const handleChange = useCallback(
    (value: string) => {
      setCollectionId(value);
      onCollectionChange?.(value);
    },
    [setCollectionId, onCollectionChange]
  );

  if (rows.length < 2) {
    const [only] = rows;
    return <span className="text-muted-foreground text-sm">{only?.name ?? 'Workspace Index'}</span>;
  }

  return (
    <Select onValueChange={handleChange} value={effectiveId}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select collection" />
      </SelectTrigger>
      <SelectContent>
        {rows.map((row) => (
          <SelectItem key={row.id} value={row.id}>
            <span className="flex items-center gap-2">
              {row.name ?? row.id}
              {row.systemRole === 'workspace-index' ? (
                <Badge variant="secondary">Managed</Badge>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
