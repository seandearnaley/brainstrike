import { Badge, Checkbox, type TreeNode, TreeTable } from '@brainstrike/ui';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { File as FileIcon, TextQuote } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useMemo } from 'react';
import type { SelectedChunk } from '../bridge/chunk-selection-store';
import { useSearchSelectionBridge } from '../bridge/use-search-selection-bridge';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';
import { buildSearchTreeNodes, fileResultChunks, type SearchNodeData } from './build-tree-nodes';

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

/** The SelectedChunk for a chunk-level row (semantic chunk or grouped text chunk). */
function chunkRowSelected(
  data: Extract<SearchNodeData, { kind: 'chunk' | 'text-chunk' }>
): SelectedChunk {
  return data.kind === 'text-chunk'
    ? { chunkId: data.chunkId, endLine: data.chunkEndLine, startLine: data.chunkStartLine }
    : { chunkId: data.chunk.chunkId, endLine: data.chunk.endLine, startLine: data.chunk.startLine };
}

/** Line a row click navigates to; `undefined` for file rows (no line). */
function openLineForData(data: SearchNodeData): number | undefined {
  switch (data.kind) {
    case 'file':
      return;
    case 'match':
      return data.match.line;
    case 'text-chunk':
      return data.chunkStartLine;
    default:
      return data.chunk.startLine;
  }
}

interface RowRenderContext {
  bridge: ReturnType<typeof useSearchSelectionBridge>;
  caseSensitive: boolean;
  highlightEnabled: boolean;
  query: string;
  showRootBadge: boolean;
  /** compositeKey -> the file's full result-chunk list (for whole-file convert). */
  siblingChunksByKey: Map<string, SelectedChunk[]>;
}

function FileRow({
  data,
  ctx,
}: {
  data: Extract<SearchNodeData, { kind: 'file' }>;
  ctx: RowRenderContext;
}): React.ReactNode {
  const { file, compositeKey } = data;
  // File is the ONLY tri-state checkbox; read it straight from the bridge (no
  // rollup from children — the selected-chunk set already knows the answer).
  const state = compositeKey === null ? 'unchecked' : ctx.bridge.fileState(compositeKey);

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
      <FileIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
      <span className="truncate font-medium text-sm">{file.path}</span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
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

/**
 * Chunk-level row: the ONLY child-checkbox level in both modes. Text mode groups
 * matches under a "Lines X–Y · N matches" chunk; semantic mode renders the chunk
 * headline/content. The checkbox drives the selection bridge with the chunk
 * bounds (identical wiring for both kinds).
 */
function ChunkRow({
  data,
  ctx,
}: {
  data: Extract<SearchNodeData, { kind: 'chunk' | 'text-chunk' }>;
  ctx: RowRenderContext;
}): React.ReactNode {
  const { compositeKey } = data;
  const chunk = chunkRowSelected(data);
  const state =
    compositeKey === null ? 'unchecked' : ctx.bridge.chunkState(compositeKey, chunk.chunkId);

  const onToggle = useCallback(() => {
    if (compositeKey !== null) {
      const siblings = ctx.siblingChunksByKey.get(compositeKey) ?? [chunk];
      ctx.bridge.toggleChunk(compositeKey, chunk, state !== 'checked', siblings);
    }
  }, [ctx.bridge, ctx.siblingChunksByKey, compositeKey, chunk, state]);

  const content =
    data.kind === 'text-chunk' ? (
      <>
        <TextQuote aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-muted-foreground text-xs">
          Lines {chunk.startLine}–{chunk.endLine}
          {data.matchCount > 1 ? ` · ${data.matchCount} matches` : ''}
        </span>
      </>
    ) : (
      <span className="truncate font-mono text-muted-foreground text-xs">
        {renderSegments(
          data.chunk.headline ? splitHeadline(data.chunk.headline) : [data.chunk.content]
        )}
      </span>
    );

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Checkbox
        aria-label={`Select lines ${chunk.startLine}-${chunk.endLine}`}
        checked={state === 'checked'}
        data-state={state}
        onCheckedChange={onToggle}
        onClick={(event) => event.stopPropagation()}
      />
      {content}
    </span>
  );
}

/**
 * Text match row: a navigation-only leaf under its chunk. No checkbox — the
 * containing chunk is the selection unit — just the line number and the
 * highlighted matched line. Row click navigates to the match line.
 */
function MatchRow({
  data,
  ctx,
}: {
  data: Extract<SearchNodeData, { kind: 'match' }>;
  ctx: RowRenderContext;
}): React.ReactNode {
  const { match } = data;
  const content = renderSegments(
    ctx.highlightEnabled
      ? highlightQuery(match.lineText, ctx.query, ctx.caseSensitive)
      : [match.lineText]
  );

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="w-9 shrink-0 text-right font-mono text-muted-foreground/70 text-xs tabular-nums">
        {match.line}
      </span>
      <span className="truncate font-mono text-foreground/80 text-xs">{content}</span>
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

  // Authoritative per-file result-chunk list (independent of tree expansion) so
  // the bridge can convert a whole-file selection into "all chunks but this one".
  const siblingChunksByKey = useMemo(() => {
    const map = new Map<string, SelectedChunk[]>();
    if (!results) {
      return map;
    }
    for (const file of results.files) {
      const adapterRootId = resolveAdapterRootId(file.dbRootId);
      if (adapterRootId === null) {
        continue;
      }
      map.set(encodeFileSelection(adapterRootId, file.path), fileResultChunks(file));
    }
    return map;
  }, [results, resolveAdapterRootId]);

  const ctx = useMemo<RowRenderContext>(
    () => ({
      bridge,
      caseSensitive,
      highlightEnabled: mode === 'text' && !isRegex,
      query: query.trim(),
      showRootBadge,
      siblingChunksByKey,
    }),
    [bridge, caseSensitive, mode, isRegex, query, showRootBadge, siblingChunksByKey]
  );

  const columns = useMemo(
    () => [
      {
        cell: ({ node }: { node: TreeNode<SearchNodeData> }) => {
          switch (node.data.kind) {
            case 'file':
              return <FileRow ctx={ctx} data={node.data} />;
            case 'match':
              return <MatchRow ctx={ctx} data={node.data} />;
            default:
              return <ChunkRow ctx={ctx} data={node.data} />;
          }
        },
        header: 'Results',
        id: 'result',
        // Reserve toggle space on EVERY row (default). A depth-0 file row shows a
        // real expand toggle (28px); leaf semantic chunk rows (depth 1) have no
        // children, so without the reserved spacer their checkbox would sit at
        // 20px indent — LEFT of the file checkbox's 28px, the reported "chunks
        // indented less than files" regression. Reserving the spacer keeps every
        // level's checkbox aligned at `depth*20 + 28`.
        reserveToggleSpace: true,
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
      const line = openLineForData(node.data);
      if (line === undefined) {
        onOpenFile(node.data.compositeKey);
        return;
      }
      onOpenFile(node.data.compositeKey, line);
    },
    [nodeById, onOpenFile]
  );

  const notices = results?.notices;

  // Count the leaf result rows actually rendered (text matches + semantic chunks)
  // so the truncated notice can name an honest limit ("first N matches") instead
  // of a false "Show more" affordance.
  const renderedMatchCount = useMemo(
    () =>
      nodes.reduce(
        (count, node) =>
          node.data.kind === 'match' || node.data.kind === 'chunk' ? count + 1 : count,
        0
      ),
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
