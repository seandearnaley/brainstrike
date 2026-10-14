import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { onEmbeddingSetUpdated, onQueueDrained } from '@brainstrike/utils/browser-events';
import { fetchCollectionsSnapshot } from '@brainstrike/vector-management';
import { Database } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
 * nothing to choose). Imported sets require an explicit collection scope even
 * when only one exists. The workspace-index row carries a "Managed" badge.
 */
type PickerRow = Pick<CollectionStatsRow, 'id' | 'name'> & {
  systemRole?: CollectionStatsRow['systemRole'];
};

export function SearchCollectionPicker(props: SearchCollectionPickerProps) {
  if (typeof window !== 'undefined' && 'collectionCatalog' in window) {
    return <NativeCollectionPicker {...props} />;
  }
  return <WebCollectionPicker {...props} />;
}

function NativeCollectionPicker(props: SearchCollectionPickerProps) {
  const [snapshot, setSnapshot] = useState<{ rows: readonly PickerRow[]; error: string | null }>({
    error: null,
    rows: [],
  });
  useEffect(() => {
    let pending: ReturnType<typeof fetchCollectionsSnapshot> | null = null;
    const refresh = () => {
      const read = fetchCollectionsSnapshot(null);
      pending = read;
      read.then(
        (rows) => {
          if (pending === read) {
            setSnapshot({ error: null, rows });
          }
        },
        (cause: unknown) => {
          if (pending === read) {
            setSnapshot({ error: describeBoundaryError(cause), rows: [] });
          }
        }
      );
    };
    const stopUpdates = onEmbeddingSetUpdated(refresh);
    const stopQueue = onQueueDrained(refresh);
    refresh();
    return () => {
      pending = null;
      stopUpdates();
      stopQueue();
    };
  }, []);
  if (snapshot.error) {
    return <span role="alert">{snapshot.error}</span>;
  }
  return <CollectionPickerRows {...props} rows={snapshot.rows} />;
}

function WebCollectionPicker(props: SearchCollectionPickerProps) {
  const { rows } = usePGliteLiveQuery<CollectionStatsRow>({
    cacheKey: makeLiveQueryKey('workspace-search-collection-stats'),
    key: 'id',
    mode: 'incremental',
    query: COLLECTION_STATS_QUERY,
  });
  return <CollectionPickerRows {...props} rows={rows} />;
}

function CollectionPickerRows({
  onCollectionChange,
  rows,
}: SearchCollectionPickerProps & { rows: readonly PickerRow[] }) {
  const collectionId = useWorkspaceSearchStore((state) => state.collectionId);
  const setCollectionId = useWorkspaceSearchStore((state) => state.setCollectionId);

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

  const [only] = rows;
  if (rows.length === 0 || (rows.length === 1 && only?.systemRole === 'workspace-index')) {
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
