import { Badge, Checkbox, type TreeNode, TreeTable } from '@brainstrike/ui';
import type * as React from 'react';
import { useCallback, useMemo } from 'react';
import { type ChunkBounds, fileCoverage } from '../bridge/range-math';
import { useSearchSelectionBridge } from '../bridge/use-search-selection-bridge';
import type { WorkspaceSearchChild } from '../core/search-result-model';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';
import { buildSearchTreeNodes, type SearchNodeData } from './build-tree-nodes';

/** A rendered headline/highlight fragment: plain text or an emphasized match. */
export type HeadlineSegment = string | { mark: string };

/**
 * Tokenizes a PostgreSQL `ts_headline` string on the literal `<mark>` / `</mark>`
 * delimiters into text and mark segments. This is the sanitization boundary —
 * the caller renders mark segments as real `<mark>` elements, never via
 * `dangerouslySetInnerHTML`, so no headline markup is interpreted as HTML.
 */
export function splitHeadline(headline: string): HeadlineSegment[] {
  const segments: HeadlineSegment[] = [];
  const pattern = /<mark>([\s\S]*?)<\/mark>/g;
  let lastIndex = 0;
  let match = pattern.exec(headline);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push(headline.slice(lastIndex, match.index));
    }
    segments.push({ mark: match[1] ?? '' });
    lastIndex = pattern.lastIndex;
    match = pattern.exec(headline);
  }
  if (lastIndex < headline.length) {
    segments.push(headline.slice(lastIndex));
  }
  return segments.length > 0 ? segments : [headline];
}

/**
 * Wraps literal occurrences of `query` inside `text` as mark segments. Text
 * mode only: the executor does not return per-match offsets, so we re-locate
 * the query in the line. When `query` is empty the whole line is plain.
 */
export function highlightQuery(
  text: string,
  query: string,
  caseSensitive: boolean
): HeadlineSegment[] {
  if (query === '') {
    return [text];
  }
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const segments: HeadlineSegment[] = [];
  let from = 0;
  let idx = haystack.indexOf(needle, from);
  while (idx !== -1) {
    if (idx > from) {
      segments.push(text.slice(from, idx));
    }
    segments.push({ mark: text.slice(idx, idx + needle.length) });
    from = idx + needle.length;
    idx = haystack.indexOf(needle, from);
  }
  if (from < text.length) {
    segments.push(text.slice(from));
  }
  return segments.length > 0 ? segments : [text];
}

function renderSegments(segments: HeadlineSegment[]): React.ReactNode {
  return segments.map((segment, index) =>
    typeof segment === 'string' ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable derived slice of one immutable string.
      <span key={index}>{segment}</span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable derived slice of one immutable string.
      <mark className="rounded-[2px] bg-yellow-200 px-0.5 dark:bg-yellow-700/60" key={index}>
        {segment.mark}
      </mark>
    )
  );
}

function childBounds(child: WorkspaceSearchChild): ChunkBounds {
  return child.kind === 'match'
    ? { endLine: child.chunkEndLine, startLine: child.chunkStartLine }
    : { endLine: child.endLine, startLine: child.startLine };
}

function childOpenLine(child: WorkspaceSearchChild): number {
  return child.kind === 'match' ? child.line : child.startLine;
}

interface RowRenderContext {
  bridge: ReturnType<typeof useSearchSelectionBridge>;
  caseSensitive: boolean;
  highlightEnabled: boolean;
  query: string;
  showRootBadge: boolean;
}

function FileRow({
  data,
  ctx,
}: {
  data: Extract<SearchNodeData, { kind: 'file' }>;
  ctx: RowRenderContext;
}): React.ReactNode {
  const { file, compositeKey } = data;
  const selected = compositeKey !== null && ctx.bridge.isFileChecked(compositeKey);
  const childStates =
    compositeKey === null
      ? []
      : file.children.map((child) => ctx.bridge.chunkState(compositeKey, childBounds(child)));
  const state = fileCoverage(selected, childStates);

  const onToggle = useCallback(() => {
    if (compositeKey !== null) {
      ctx.bridge.toggleFile(compositeKey, state !== 'checked');
    }
  }, [ctx.bridge, compositeKey, state]);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Checkbox
        aria-label={`Select ${file.path}`}
        checked={state === 'indeterminate' ? 'indeterminate' : state === 'checked'}
        data-state={state}
        onCheckedChange={onToggle}
        onClick={(event) => event.stopPropagation()}
      />
      <span className="truncate font-medium text-sm">{file.path}</span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {file.children.length} {file.children.length === 1 ? 'match' : 'matches'}
      </span>
      {ctx.showRootBadge && file.rootDisplayName ? (
        <Badge className="shrink-0" variant="secondary">
          {file.rootDisplayName}
        </Badge>
      ) : null}
    </span>
  );
}

function ChildRow({
  data,
  ctx,
}: {
  data: Extract<SearchNodeData, { kind: 'child' }>;
  ctx: RowRenderContext;
}): React.ReactNode {
  const { child, compositeKey } = data;
  const bounds = childBounds(child);
  const state = compositeKey === null ? 'unchecked' : ctx.bridge.chunkState(compositeKey, bounds);

  const onToggle = useCallback(() => {
    if (compositeKey !== null) {
      ctx.bridge.toggleChunk(compositeKey, bounds, state !== 'checked');
    }
  }, [ctx.bridge, compositeKey, bounds, state]);

  const content =
    child.kind === 'match'
      ? renderSegments(
          ctx.highlightEnabled
            ? highlightQuery(child.lineText, ctx.query, ctx.caseSensitive)
            : [child.lineText]
        )
      : renderSegments(child.headline ? splitHeadline(child.headline) : [child.content]);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Checkbox
        aria-label={`Select lines ${bounds.startLine}-${bounds.endLine}`}
        checked={state === 'indeterminate' ? 'indeterminate' : state === 'checked'}
        data-state={state}
        onCheckedChange={onToggle}
        onClick={(event) => event.stopPropagation()}
      />
      <span className="truncate font-mono text-muted-foreground text-xs">{content}</span>
    </span>
  );
}

export interface SearchResultsTreeProps {
  /**
   * Row-click navigation. Match rows pass their match line, chunk rows pass
   * the chunk `startLine`, file rows pass no line.
   */
  onOpenFile: (compositeKey: string, line?: number) => void;
  /** Optional paging affordance for `truncated` results (v1: may be absent). */
  onShowMore?: () => void;
  /**
   * DB rootId → adapter rootId. Files whose root is not mounted (null) are
   * omitted — the tree needs this to build actionable composite keys, which
   * the session store does not hold.
   */
  resolveAdapterRootId: (dbRootId: string) => string | null;
}

/**
 * Results tree for workspace search. Composes the shared TreeTable over the
 * pre-flattened row model from `buildSearchTreeNodes`. Row CLICK navigates;
 * the per-row checkbox drives the selection bridge directly (tri-state), which
 * TreeTable's Set-based `showCheckbox` cannot express — see the report.
 */
export function SearchResultsTree({
  onOpenFile,
  resolveAdapterRootId,
  onShowMore,
}: SearchResultsTreeProps): React.ReactNode {
  const results = useWorkspaceSearchStore((state) => state.results);
  const query = useWorkspaceSearchStore((state) => state.query);
  const mode = useWorkspaceSearchStore((state) => state.mode);
  const isRegex = useWorkspaceSearchStore((state) => state.isRegex);
  const caseSensitive = useWorkspaceSearchStore((state) => state.caseSensitive);
  const expandedIds = useWorkspaceSearchStore((state) => state.expandedIds);
  const toggleExpanded = useWorkspaceSearchStore((state) => state.toggleExpanded);
  const bridge = useSearchSelectionBridge();

  const nodes = useMemo(
    () => (results ? buildSearchTreeNodes({ expandedIds, resolveAdapterRootId, results }) : []),
    [results, expandedIds, resolveAdapterRootId]
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, TreeNode<SearchNodeData>>();
    for (const node of nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);

  const showRootBadge = useMemo(() => {
    const roots = new Set<string>();
    for (const node of nodes) {
      if (node.data.kind === 'file') {
        roots.add(node.data.file.dbRootId);
      }
    }
    return roots.size > 1;
  }, [nodes]);

  const ctx = useMemo<RowRenderContext>(
    () => ({
      bridge,
      caseSensitive,
      highlightEnabled: mode === 'text' && !isRegex,
      query: query.trim(),
      showRootBadge,
    }),
    [bridge, caseSensitive, mode, isRegex, query, showRootBadge]
  );

  const columns = useMemo(
    () => [
      {
        cell: ({ node }: { node: TreeNode<SearchNodeData> }) =>
          node.data.kind === 'file' ? (
            <FileRow ctx={ctx} data={node.data} />
          ) : (
            <ChildRow ctx={ctx} data={node.data} />
          ),
        header: 'Results',
        id: 'result',
      },
    ],
    [ctx]
  );

  const handleSelect = useCallback(
    (nodeId: string | null) => {
      if (nodeId === null) {
        return;
      }
      const node = nodeById.get(nodeId);
      if (!node || node.data.compositeKey === null) {
        return;
      }
      if (node.data.kind === 'file') {
        onOpenFile(node.data.compositeKey);
        return;
      }
      onOpenFile(node.data.compositeKey, childOpenLine(node.data.child));
    },
    [nodeById, onOpenFile]
  );

  const notices = results?.notices;

  // Count the match/chunk rows actually rendered so the truncated notice can name
  // an honest limit ("first N matches") instead of a false "Show more" affordance.
  const renderedMatchCount = useMemo(
    () => nodes.reduce((count, node) => (node.data.kind === 'child' ? count + 1 : count), 0),
    [nodes]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      {notices?.scanLimited ? (
        <p className="text-muted-foreground text-xs" role="status">
          Broad pattern — results limited
        </p>
      ) : null}
      {notices && notices.skippedMissingLineMetadata > 0 ? (
        <p className="text-muted-foreground text-xs" role="status">
          {notices.skippedMissingLineMetadata} results hidden (stale or unattributed index rows —
          reindexing fixes this)
        </p>
      ) : null}
      {notices?.candidatesTruncated ? (
        <p className="text-muted-foreground text-xs" role="status">
          Match list may be incomplete (candidate pool capped) — narrow the query.
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <TreeTable<SearchNodeData>
          ariaRole="treegrid"
          autoWindowingContext="search"
          columns={columns}
          emptyState={<p className="p-3 text-muted-foreground text-sm">No matches found</p>}
          expandedIds={expandedIds}
          nodes={nodes}
          nodesArePreFlattened
          onSelect={handleSelect}
          onToggleExpand={toggleExpanded}
          showHeader={false}
          windowingStrategy="auto"
        />
      </div>
      {notices?.truncated ? (
        onShowMore ? (
          <button
            className="self-start text-primary text-xs underline"
            onClick={onShowMore}
            type="button"
          >
            Show more
          </button>
        ) : (
          // No paging affordance is wired: state the honest limit instead of a
          // false "Show more" that does nothing.
          <p className="text-muted-foreground text-xs" role="status">
            Results limited to first {renderedMatchCount} matches
          </p>
        )
      ) : null}
    </div>
  );
}
