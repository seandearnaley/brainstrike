import {
  type CrossRootUsageRow,
  hasDurableAssistantUsageCapability,
} from '@brainstrike/assistant-data';
import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { useThreadFolderRows } from '../hooks/use-thread-folder-rows';
import { getThreadGroupsCapability } from '../thread-groups-capability';

/**
 * Per-(root, provider, model) usage subtotal joined with the root's display
 * name (CrossRootUsageRow carries `rootDisplayName`, null for the unattributed
 * bucket or a legacy path-remapped join miss). NULL root_id is the
 * unattributed bucket.
 */
export type CrossRootUsageQueryRow = CrossRootUsageRow;

/** Desktop usage comes exclusively from the agent host. */
export interface CrossRootCostState {
  /** Whether durable cross-root usage is recorded here (desktop assistant backend). */
  readonly available: boolean;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly rows: readonly CrossRootUsageQueryRow[];
}

interface MappedRows {
  readonly error: Error | null;
  readonly rows: readonly CrossRootUsageQueryRow[];
}

const NO_HOST_ROOT_USAGE: readonly CrossRootUsageRow[] = [];
const NO_PARAMS: readonly unknown[] = [];

/** The roots table's display names, bounded as the usage aggregation bounds them. */
const ROOT_DISPLAY_NAMES_SQL =
  'SELECT id, SUBSTR(display_name, 1, 512) AS "displayName" FROM roots';

/** Strict, like the usage rows: a malformed roots row THROWS, never a fabricated name. */
function parseRootName(raw: Record<string, unknown>): readonly [string, string | null] {
  const id = raw['id'];
  const displayName = raw['displayName'];
  if (typeof id !== 'string' || !(displayName === null || typeof displayName === 'string')) {
    throw new Error('Invalid roots display-name row');
  }
  return [id, displayName];
}

/**
 * A host row named by the roots table, as the usage aggregation joins it; a
 * root the table does not name keeps the name its run committed, if any.
 */
function nameHostRows(
  hostRootUsage: readonly CrossRootUsageRow[],
  rawNames: readonly Record<string, unknown>[]
): readonly CrossRootUsageRow[] {
  const names = new Map(rawNames.map(parseRootName));
  return hostRootUsage.map((row) => {
    const name = row.rootId === null ? undefined : names.get(row.rootId);
    return name ? { ...row, rootDisplayName: name } : row;
  });
}

/** `hostRootUsage`: agent-host threads' committed provider calls per root, listed beside. */
export function useCrossRootCost(
  hostRootUsage: readonly CrossRootUsageRow[] = NO_HOST_ROOT_USAGE
): CrossRootCostState {
  const native = getThreadGroupsCapability();
  const database = usePGliteDatabase({ enabled: !native });
  const rootIds = useMemo(
    () => (native ? hostRootUsage.flatMap((row) => (row.rootId === null ? [] : [row.rootId])) : []),
    [native, hostRootUsage]
  );
  const folders = useThreadFolderRows(null, rootIds);
  const available = hasDurableAssistantUsageCapability();
  const namesQuery = usePGliteLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('cross-root-root-names'),
    enabled: available && database !== null && hostRootUsage.some((row) => row.rootId !== null),
    params: NO_PARAMS,
    query: ROOT_DISPLAY_NAMES_SQL,
  });

  const mapped = useMemo<MappedRows>(() => {
    try {
      return {
        error: null,
        rows: available ? nameHostRows(hostRootUsage, namesQuery.rows) : NO_HOST_ROOT_USAGE,
      };
    } catch (error: unknown) {
      return { error: error instanceof Error ? error : new Error(String(error)), rows: [] };
    }
  }, [available, hostRootUsage, namesQuery.rows]);

  if (native) {
    return {
      available,
      error: folders.error,
      loading: folders.loading,
      rows: available
        ? hostRootUsage.map((row) => ({
            ...row,
            rootDisplayName:
              (row.rootId === null
                ? undefined
                : folders.rowsByRootId.get(row.rootId)?.displayName) ?? row.rootDisplayName,
          }))
        : NO_HOST_ROOT_USAGE,
    };
  }
  return {
    available,
    error: namesQuery.error ?? mapped.error,
    loading: namesQuery.loading,
    rows: mapped.rows,
  };
}
