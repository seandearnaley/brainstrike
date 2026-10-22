import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { EmbeddingSetSystemRole } from '@brainstrike/db';
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

export interface SearchCollectionPickerProps {
  onCollectionChange?: (id: string) => void;
}

/**
 * Embedding-set picker for workspace search. With only the managed
 * workspace-index set present, renders quiet text (no combobox — there is
 * nothing to choose). Imported sets require an explicit collection scope even
 * when only one exists. The workspace-index row carries a "Managed" badge.
 */
interface PickerRow {
  id: string;
  name: string | null;
  systemRole?: EmbeddingSetSystemRole | null;
}

/**
 * Resolves the row for the currently selected embedding set. `collectionId
 * === null` means "resolve the workspace-index set" (the store's
 * documented convention — see `workspace-search-store.ts`).
 */
function resolveEffectiveRow<T extends PickerRow>(
  rows: readonly T[],
  collectionId: string | null
): T | null {
  if (collectionId) {
    return rows.find((row) => row.id === collectionId) ?? null;
  }
  return rows.find((row) => row.systemRole === 'workspace-index') ?? null;
}

export function SearchCollectionPicker(props: SearchCollectionPickerProps) {
  const [snapshot, setSnapshot] = useState<{ rows: readonly PickerRow[]; error: string | null }>({
    error: null,
    rows: [],
  });
  useEffect(() => {
    let pending: ReturnType<typeof fetchCollectionsSnapshot> | null = null;
    const refresh = () => {
      const read = fetchCollectionsSnapshot();
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

function CollectionPickerRows({
  onCollectionChange,
  rows,
}: SearchCollectionPickerProps & { rows: readonly PickerRow[] }) {
  const collectionId = useWorkspaceSearchStore((state) => state.collectionId);
  const setCollectionId = useWorkspaceSearchStore((state) => state.setCollectionId);

  const effectiveId = useMemo(
    () => resolveEffectiveRow(rows, collectionId)?.id ?? '',
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
