import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  type ActivityClusterSlot,
  type ActivityGroupView,
  ActivityGroupViewContext,
} from './activity-group-view-context';
import type { ActivityFilter, ActivityFilterOption } from './activity-group-view-model';
import { StepRowHeader } from './activity-step-row';
import { formatActivityDuration } from './tool-durations';
import { useActivityGroupView } from './use-activity-group-view';

export function ActivityGroupViewProvider({
  children,
  view,
}: {
  readonly children: ReactNode;
  readonly view: ActivityGroupView;
}): ReactNode {
  return (
    <ActivityGroupViewContext.Provider value={view}>{children}</ActivityGroupViewContext.Provider>
  );
}

function ActivityClusterRow({
  slot,
  view,
}: {
  readonly slot: ActivityClusterSlot;
  readonly view: ActivityGroupView;
}): ReactNode {
  const { cluster, open } = slot;
  const preview = [
    ...cluster.preview,
    ...(cluster.morePreview > 0 ? [`+${cluster.morePreview}`] : []),
  ].join(', ');
  return (
    <div
      className="bs-activity-cluster"
      data-cluster-id={cluster.id}
      data-state={open ? 'open' : 'closed'}
      data-testid="activity-cluster"
    >
      <StepRowHeader
        // Every member wrapper, as an IDREF list: they are siblings in the
        // step list rather than one container, and exist only while open.
        bodyId={cluster.memberIds
          .map((_id, index) => view.memberDomId(cluster.id, index))
          .join(' ')}
        expanded={open}
        family={cluster.verb.family}
        label={
          open ? `Hide ${cluster.memberIds.length} calls` : `Show ${cluster.memberIds.length} calls`
        }
        onToggle={() => view.toggleCluster(cluster.id)}
        state="done"
        target={preview || null}
        {...(cluster.durationMs === undefined
          ? {}
          : {
              timing: (
                <span title="Total execution time">
                  {formatActivityDuration(cluster.durationMs)}
                </span>
              ),
            })}
        verb={cluster.label}
      />
    </div>
  );
}

/**
 * A tool step's place in its group: itself, nothing (folded away, or outside
 * the active filter), or — for a cluster's first member — the cluster row,
 * followed by the member while the cluster is open. A folded member is not
 * mounted at all, so a long run builds rows for what is visible only.
 */
export function ActivityToolSlot({
  children,
  toolCallId,
}: {
  readonly children: ReactNode;
  readonly toolCallId: string;
}): ReactNode {
  const view = useActivityGroupView();
  if (!view) {
    return children;
  }
  if (view.shown) {
    return view.shown.has(toolCallId) ? children : null;
  }
  const slot = view.clusterOf.get(toolCallId);
  if (!slot) {
    return children;
  }
  return (
    <>
      {slot.index === 0 ? <ActivityClusterRow slot={slot} view={view} /> : null}
      {slot.open ? (
        <div className="bs-cluster-member" id={view.memberDomId(slot.cluster.id, slot.index)}>
          {children}
        </div>
      ) : null}
    </>
  );
}

/** Readable reasoning shows under All; a family or failure filter hides it. */
export function ActivityReasoningSlot({ children }: { readonly children: ReactNode }): ReactNode {
  const view = useActivityGroupView();
  return view?.shown ? null : children;
}

/**
 * The body's filter bar for a long group: All, each family present, Failed,
 * plus one control that opens or closes every cluster at once.
 */
export function ActivityFilterBar({
  allClustersOpen,
  clusterCount,
  filter,
  onFilter,
  onToggleAllClusters,
  options,
}: {
  readonly allClustersOpen: boolean;
  readonly clusterCount: number;
  readonly filter: ActivityFilter;
  readonly onFilter: (filter: ActivityFilter) => void;
  readonly onToggleAllClusters: () => void;
  readonly options: readonly ActivityFilterOption[];
}): ReactNode {
  if (options.length === 0) {
    return null;
  }
  const ToggleIcon = allClustersOpen ? ChevronsDownUp : ChevronsUpDown;
  return (
    <div className="bs-activity-filters" data-testid="assistant-activity-filters">
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form field set. */}
      <div aria-label="Filter steps" className="bs-activity-filter-chips" role="group">
        {options.map((option) => (
          <button
            aria-pressed={filter === option.filter}
            className="bs-activity-filter-chip"
            data-filter={option.filter}
            key={option.filter}
            onClick={() => onFilter(option.filter)}
            type="button"
          >
            {option.label}
            <span className="bs-activity-filter-count">{option.count}</span>
          </button>
        ))}
      </div>
      {clusterCount > 0 && filter === 'all' ? (
        <button className="bs-activity-filter-action" onClick={onToggleAllClusters} type="button">
          <ToggleIcon aria-hidden="true" className="size-3.5" />
          {allClustersOpen ? 'Collapse all' : 'Expand all'}
        </button>
      ) : null}
    </div>
  );
}
