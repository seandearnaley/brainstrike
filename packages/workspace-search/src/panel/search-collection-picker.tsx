import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { Database } from 'lucide-react';
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
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm"
        data-testid={only ? 'workspace-search-single-collection' : undefined}
      >
        <Database aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{only?.name ?? 'Workspace Index'}</span>
      </span>
    );
  }

  return (
    <Select onValueChange={handleChange} value={effectiveId}>
      <SelectTrigger aria-label="Search collection" className="h-8 w-full">
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
