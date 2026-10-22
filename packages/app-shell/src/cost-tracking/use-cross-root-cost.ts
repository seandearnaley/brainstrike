import {
  type CrossRootUsageRow,
  hasDurableAssistantUsageCapability,
} from '@brainstrike/assistant-data';
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

const NO_HOST_ROOT_USAGE: readonly CrossRootUsageRow[] = [];

/** `hostRootUsage`: agent-host threads' committed provider calls per root, listed beside. */
export function useCrossRootCost(
  hostRootUsage: readonly CrossRootUsageRow[] = NO_HOST_ROOT_USAGE
): CrossRootCostState {
  const native = getThreadGroupsCapability();
  const rootIds = useMemo(
    () => (native ? hostRootUsage.flatMap((row) => (row.rootId === null ? [] : [row.rootId])) : []),
    [native, hostRootUsage]
  );
  const folders = useThreadFolderRows(rootIds);
  const available = hasDurableAssistantUsageCapability();
  return {
    available,
    error: folders.error,
    loading: folders.loading,
    rows: available
      ? hostRootUsage.map((row) => ({
          ...row,
          rootDisplayName:
            (row.rootId === null ? undefined : folders.rowsByRootId.get(row.rootId)?.displayName) ??
            row.rootDisplayName,
        }))
      : NO_HOST_ROOT_USAGE,
  };
}
