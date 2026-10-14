import { createContext } from 'react';
import type { ActivityCluster } from './activity-group-view-model';

export interface ActivityClusterSlot {
  readonly cluster: ActivityCluster;
  /** Position in the cluster; the head (0) draws the cluster row. */
  readonly index: number;
  readonly open: boolean;
}

/**
 * How the group lays out its own steps (see `activity-group-view-model.ts`).
 * The group provides it; each step leaf asks whether it is folded, filtered
 * out or the head of a cluster. Undefined outside a group: a standalone card
 * (an approval-bearing call) always renders as itself.
 */
export interface ActivityGroupView {
  /** Membership of a folded step; absent for a step drawn on its own. */
  readonly clusterOf: ReadonlyMap<string, ActivityClusterSlot>;
  /** The DOM id of one folded member's wrapper, for the cluster row's `aria-controls`. */
  readonly memberDomId: (clusterId: string, index: number) => string;
  /** Steps a family or failure filter shows; null while the filter is All. */
  readonly shown: ReadonlySet<string> | null;
  /** Whether rows name their resolved root; only when the group spans more than one. */
  readonly showRootChip: boolean;
  readonly toggleCluster: (clusterId: string) => void;
}

export const ActivityGroupViewContext = createContext<ActivityGroupView | undefined>(undefined);
