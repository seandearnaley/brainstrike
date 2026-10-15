import type { PartState } from '@assistant-ui/react';
import { readMcpTaskToolInvocationResult } from '@brainstrike/assistant-contract';
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { adjacentFailure, findStepRow, handleActivityGroupKey } from './activity-group-keys';
import type { ActivityClusterSlot, ActivityGroupView } from './activity-group-view-context';
import {
  type ActivityCluster,
  type ActivityFilter,
  type ActivityFilterOption,
  type ActivityTailEntry,
  activityFilterOptions,
  deriveActivityClusters,
  deriveLiveTail,
  deriveRunStrip,
  matchesActivityFilter,
  type RunStripMark,
} from './activity-group-view-model';
import type { ActivityStep } from './activity-trace-model';
import { isSubagentDelegationToolName } from './subagent-tool-cards';
import { extractResolvedRootName } from './tool-fallback-state';
import { useStableByKey } from './use-stable-by-key';
import type { ToolResultRenderer } from './use-tool-result-renderers';

/**
 * The group's root element handle, returned BESIDE `ActivityGroupLayout` rather
 * than inside it. React Compiler's `refs` rule infers any object carrying a ref
 * as a ref container, so folding `rootRef` into the layout made every
 * `layout.<field>` read during render report "Cannot access refs during render"
 * (18 findings in `assistant-activity-parts.tsx`). Keeping the two apart lets
 * the layout stay an ordinary derived value the component may read freely.
 */
export interface ActivityGroupLayoutResult {
  readonly layout: ActivityGroupLayout;
  readonly rootRef: RefObject<HTMLDivElement | null>;
}

export interface ActivityGroupLayout {
  readonly allClustersOpen: boolean;
  readonly clusterCount: number;
  readonly expanded: boolean;
  readonly filter: ActivityFilter;
  readonly filterOptions: readonly ActivityFilterOption[];
  /** Opens the group at a step: clears a filter that hides it, unfolds its cluster, focuses its row. */
  readonly jumpTo: (stepId: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly setExpanded: (expanded: boolean) => void;
  readonly setFilter: (filter: ActivityFilter) => void;
  /** Opens the first failure; undefined when nothing failed. */
  readonly showFirstFailure: (() => void) | undefined;
  readonly strip: readonly RunStripMark[];
  readonly tail: readonly ActivityTailEntry[];
  readonly toggleAllClusters: () => void;
  readonly view: ActivityGroupView;
}

/**
 * A card that must stay mounted and on its own row: an approval-bearing call,
 * a delegation, or a result with its own host renderer (an MCP app, an MCP
 * task). Folding one would unmount its controls or its live session.
 */
function keepsItsOwnCard(part: PartState, renderers: readonly ToolResultRenderer[]): boolean {
  if (part.type !== 'tool-call') {
    return false;
  }
  if (part.approval !== undefined || isSubagentDelegationToolName(part.toolName)) {
    return true;
  }
  if (part.result === undefined) {
    return false;
  }
  return (
    renderers.some((renderer) => renderer.matches(part.result)) ||
    readMcpTaskToolInvocationResult(part.result) !== undefined
  );
}

/** Structural identity of a cluster layout; equal keys mean equal rows. */
function clusterKey(clusters: readonly ActivityCluster[]): string {
  return JSON.stringify(
    clusters.map((cluster) => [
      cluster.id,
      cluster.memberIds.length,
      cluster.label,
      cluster.preview,
      cluster.morePreview,
      cluster.durationMs ?? null,
    ])
  );
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Everything an activity group owns beyond its trace: its disclosure, the
 * folded clusters and which are open, the family filter, the live tail, the
 * run strip, jumps to a step and the group's keys. Collapsed by default at all
 * times; a jump is the one thing besides a toggle that opens it.
 */
export function useActivityGroupLayout(
  steps: readonly ActivityStep[],
  groupParts: readonly PartState[],
  renderers: readonly ToolResultRenderer[]
): ActivityGroupLayoutResult {
  const domBase = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [requestedFilter, setFilter] = useState<ActivityFilter>('all');
  const [openClusters, setOpenClusters] = useState<ReadonlySet<string>>(() => new Set());
  const [focusRequest, setFocusRequest] = useState<{ readonly stepId: string } | null>(null);

  const unfoldable = useMemo(
    () =>
      new Set(
        groupParts.flatMap((part) =>
          part.type === 'tool-call' && keepsItsOwnCard(part, renderers) ? [part.toolCallId] : []
        )
      ),
    [groupParts, renderers]
  );
  const derivedClusters = useMemo(
    () => deriveActivityClusters(steps, unfoldable),
    [steps, unfoldable]
  );
  const clusters = useStableByKey(derivedClusters, clusterKey(derivedClusters));
  const filterOptions = useMemo(() => activityFilterOptions(steps), [steps]);
  // A filter whose chip is gone (the group shrank below the bar's threshold)
  // reads as All rather than hiding every row.
  const filter = filterOptions.some((option) => option.filter === requestedFilter)
    ? requestedFilter
    : 'all';
  const derivedShown = useMemo(
    () =>
      filter === 'all'
        ? null
        : new Set(
            steps.filter((step) => matchesActivityFilter(step, filter)).map((step) => step.id)
          ),
    [steps, filter]
  );
  const shown = useStableByKey(derivedShown, derivedShown ? [...derivedShown].join('\u0000') : '');
  const showRootChip = useMemo(() => {
    const roots = new Set<string>();
    for (const part of groupParts) {
      const root = part.type === 'tool-call' ? extractResolvedRootName(part.result) : undefined;
      if (root) {
        roots.add(root);
      }
    }
    return roots.size > 1;
  }, [groupParts]);

  const toggleCluster = useCallback((clusterId: string) => {
    setOpenClusters((previous) => {
      const next = new Set(previous);
      if (!next.delete(clusterId)) {
        next.add(clusterId);
      }
      return next;
    });
  }, []);
  const memberDomId = useCallback(
    (clusterId: string, index: number) => `${domBase}-${clusterId}-${index}`,
    [domBase]
  );
  const view = useMemo((): ActivityGroupView => {
    const clusterOf = new Map<string, ActivityClusterSlot>();
    for (const cluster of clusters) {
      const open = openClusters.has(cluster.id);
      cluster.memberIds.forEach((id, index) => {
        clusterOf.set(id, { cluster, index, open });
      });
    }
    return { clusterOf, memberDomId, shown, showRootChip, toggleCluster };
  }, [clusters, memberDomId, openClusters, shown, showRootChip, toggleCluster]);

  const jumpTo = useCallback(
    (stepId: string) => {
      setExpanded(true);
      const step = steps.find((candidate) => candidate.id === stepId);
      if (step && !matchesActivityFilter(step, filter)) {
        setFilter('all');
      }
      const cluster = clusters.find((candidate) => candidate.memberIds.includes(stepId));
      if (cluster) {
        setOpenClusters((previous) => new Set(previous).add(cluster.id));
      }
      setFocusRequest({ stepId });
    },
    [clusters, filter, steps]
  );
  // Focus once the opened body and unfolded rows have committed.
  useEffect(() => {
    if (!focusRequest) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      const row = root ? findStepRow(root, focusRequest.stepId) : undefined;
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  const failures = steps.filter((step) => step.state === 'failed');
  const firstFailure = failures[0]?.id;
  const showFirstFailure = firstFailure === undefined ? undefined : () => jumpTo(firstFailure);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    handleActivityGroupKey(event, (direction, from) => {
      const next = adjacentFailure(steps, direction, from);
      if (next !== undefined) {
        jumpTo(next);
      }
      return next !== undefined;
    });
  };
  const allClustersOpen = clusters.length > 0 && clusters.every((c) => openClusters.has(c.id));
  const toggleAllClusters = (): void => {
    setOpenClusters(allClustersOpen ? new Set() : new Set(clusters.map((cluster) => cluster.id)));
  };
  const tail = useMemo(() => deriveLiveTail(steps), [steps]);
  const strip = useMemo(() => deriveRunStrip(steps), [steps]);

  return {
    layout: {
      allClustersOpen,
      clusterCount: clusters.length,
      expanded,
      filter,
      filterOptions,
      jumpTo,
      onKeyDown,
      setExpanded,
      setFilter,
      showFirstFailure,
      strip,
      tail,
      toggleAllClusters,
      view,
    },
    rootRef,
  };
}
