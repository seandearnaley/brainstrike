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
type CrossRootUsageQueryRow = CrossRootUsageRow;

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
  // A worktree is named after its repository's Local root, so that root is looked up too.
  const rootIds = useMemo(
    () =>
      native
        ? [...new Set(hostRootUsage.flatMap((row) => [row.rootId, row.localRootId]))].filter(
            (rootId) => rootId !== null
          )
        : [],
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
            folders.rowsByRootId.get(row.localRootId ?? row.rootId ?? '')?.displayName ??
            row.rootDisplayName,
        }))
      : NO_HOST_ROOT_USAGE,
  };
}
