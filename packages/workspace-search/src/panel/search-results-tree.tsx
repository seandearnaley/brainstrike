import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import {
  Badge,
  Checkbox,
  type CheckboxState,
  type TreeNode,
  TreeTable,
  type TreeTableCheckboxNextState,
} from '@brainstrike/ui';
import { File as FileIcon, TextQuote } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useMemo } from 'react';
import type { SelectedChunk } from '../bridge/chunk-selection-store';
import type { FileSelectionState } from '../bridge/use-search-selection-bridge';
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

/** Where a row click navigates. Chunk rows also carry a range to select. */
export interface SearchOpenTarget {
  line: number;
  selection?: { startLine: number; endLine: number };
}

/**
 * Open target for a row click; `undefined` for file rows (whole-file open, no
 * line). Match rows navigate to the match line only. Chunk rows (semantic and
 * grouped text) carry the full chunk range so the opened file selects the block
 * (highlighted + ready to copy), scrolled to its start.
 */
function openTargetForData(data: SearchNodeData): SearchOpenTarget | undefined {
  switch (data.kind) {
    case 'file':
      return;
    case 'match':
      return { line: data.match.line };
    case 'text-chunk':
      return {
        line: data.chunkStartLine,
        selection: { endLine: data.chunkEndLine, startLine: data.chunkStartLine },
      };
    default:
      return {
        line: data.chunk.startLine,
        selection: { endLine: data.chunk.endLine, startLine: data.chunk.startLine },
      };
  }
}

interface RowRenderContext {
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
  const { file } = data;
  // Checkbox lives on TreeTable via the pluggable API (file = only tri-state).
  return (
    <span className="flex min-w-0 items-center gap-2">
      <FileIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
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
 * Chunk-level row content: the ONLY child-checkbox level in both modes (checkbox
 * itself is rendered by TreeTable). Text mode groups matches under a
 * "Lines X–Y · N matches" chunk; semantic mode renders the chunk headline/content.
 */
function ChunkRow({
  data,
}: {
  data: Extract<SearchNodeData, { kind: 'chunk' | 'text-chunk' }>;
}): React.ReactNode {
  const chunk = chunkRowSelected(data);
  // Checkbox lives on TreeTable via the pluggable API (chunk = binary only).
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

  return <span className="flex min-w-0 items-center gap-2">{content}</span>;
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

/**
 * Rolls up the header tri-state from `fileState` over the currently rendered
 * (loaded) files only: all checked -> checked; any checked or indeterminate
 * (a chunk-refined file reads 'indeterminate' from fileState and counts as
 * "some") -> indeterminate; none -> unchecked.
 */
function rollupSelectAllState(
  bridge: ReturnType<typeof useSearchSelectionBridge>,
  fileKeys: readonly string[]
): FileSelectionState {
  let checkedCount = 0;
  let anySelected = false;
  for (const key of fileKeys) {
    const state = bridge.fileState(key);
    if (state === 'checked') {
      checkedCount += 1;
      anySelected = true;
    } else if (state === 'indeterminate') {
      anySelected = true;
    }
  }
  if (fileKeys.length > 0 && checkedCount === fileKeys.length) {
    return 'checked';
  }
  return anySelected ? 'indeterminate' : 'unchecked';
}

/**
 * Tri-state header above the tree: selects/deselects every currently loaded
 * (rendered) file as a whole-file membership. Never touches files outside the
 * loaded result set — `fileKeys` is exactly the composite keys of the rendered
 * file rows. Renders nothing when there are no loaded files.
 */
function SelectAllHeader({
  bridge,
  fileKeys,
}: {
  bridge: ReturnType<typeof useSearchSelectionBridge>;
  fileKeys: readonly string[];
}): React.ReactNode {
  const state = rollupSelectAllState(bridge, fileKeys);
  const label = `Select ${fileKeys.length} shown`;

  const onToggle = useCallback(() => {
    const nextChecked = state !== 'checked';
    for (const key of fileKeys) {
      bridge.toggleFile(key, nextChecked);
    }
  }, [bridge, fileKeys, state]);

  return (
    <div className="flex items-center gap-2 border-b px-2 py-1.5">
      <Checkbox
        aria-label={label}
        checked={state === 'indeterminate' ? 'indeterminate' : state === 'checked'}
        data-state={state}
        onCheckedChange={onToggle}
      />
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

export interface SearchResultsTreeProps {
  /**
   * Row-click navigation. Match rows pass `{ line }` (their match line); chunk
   * rows pass `{ line, selection }` (the chunk range to scroll to AND select in
   * the opened file so the block is highlighted, ready to copy); file rows pass
   * no target.
   */
  onOpenFile: (compositeKey: string, target?: SearchOpenTarget) => void;
  /** Optional paging affordance for `truncated` results (v1: may be absent). */
  onShowMore?: () => void;
  /**
   * DB rootId → adapter rootId. Files whose root is not mounted (null) are
   * omitted — the tree needs this to build actionable composite keys, which
   * the session store does not hold.
   */
  resolveAdapterRootId: (dbRootId: string) => string | null;
  /**
   * Count of currently mounted workspace roots. In a multi-root workspace
   * (count > 1) every file row shows its root badge — even when the current
   * result set happens to span a single root, the user cannot tell WHICH root
   * without it. Defaults to 0 (badge falls back to result-set root diversity).
   */
  workspaceRootCount?: number;
}

/**
 * Results tree for workspace search. Composes the shared TreeTable over the
 * pre-flattened row model from `buildSearchTreeNodes`. Row CLICK navigates;
 * checkboxes use TreeTable's pluggable API (`getCheckboxState` /
 * `onCheckboxChange`) so the selected-chunk set stays the source of truth —
 * file = tri-state, chunk = binary, match leaves = hidden.
 */
export function SearchResultsTree({
  onOpenFile,
  resolveAdapterRootId,
  onShowMore,
  workspaceRootCount = 0,
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

  // Composite keys of every currently loaded (rendered) file row, regardless of
  // expansion — select-all operates on this set only, never on files omitted
  // upstream for an unmounted root.
  const fileKeys = useMemo(
    () =>
      nodes.reduce<string[]>((keys, node) => {
        if (node.data.kind === 'file' && node.data.compositeKey !== null) {
          keys.push(node.data.compositeKey);
        }
        return keys;
      }, []),
    [nodes]
  );

  // Badge whenever the WORKSPACE is multi-root (the user needs attribution
  // even for a single-root result set), falling back to result-set diversity
  // when the caller does not provide the mounted-root count.
  const showRootBadge = useMemo(() => {
    if (workspaceRootCount > 1) {
      return true;
    }
    const roots = new Set<string>();
    for (const node of nodes) {
      if (node.data.kind === 'file') {
        roots.add(node.data.file.dbRootId);
      }
    }
    return roots.size > 1;
  }, [nodes, workspaceRootCount]);

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
      caseSensitive,
      highlightEnabled: mode === 'text' && !isRegex,
      query: query.trim(),
      showRootBadge,
    }),
    [caseSensitive, mode, isRegex, query, showRootBadge]
  );

  const getCheckboxState = useCallback(
    (node: TreeNode<SearchNodeData>): CheckboxState | 'hidden' => {
      const { data } = node;
      if (data.kind === 'match' || data.compositeKey === null) {
        return 'hidden';
      }
      if (data.kind === 'file') {
        return bridge.fileState(data.compositeKey);
      }
      // chunk | text-chunk — binary only (bridge never returns indeterminate).
      return bridge.chunkState(data.compositeKey, chunkRowSelected(data).chunkId);
    },
    [bridge]
  );

  const getCheckboxAriaLabel = useCallback((node: TreeNode<SearchNodeData>): string | undefined => {
    const { data } = node;
    if (data.kind === 'file') {
      return `Select ${data.file.path}`;
    }
    if (data.kind === 'chunk' || data.kind === 'text-chunk') {
      const chunk = chunkRowSelected(data);
      return `Select lines ${chunk.startLine}-${chunk.endLine}`;
    }
    return;
  }, []);

  const onCheckboxChange = useCallback(
    (node: TreeNode<SearchNodeData>, nextState: TreeTableCheckboxNextState) => {
      const { data } = node;
      if (data.compositeKey === null) {
        return;
      }
      const nextChecked = nextState === 'checked';
      if (data.kind === 'file') {
        bridge.toggleFile(data.compositeKey, nextChecked);
        return;
      }
      if (data.kind === 'chunk' || data.kind === 'text-chunk') {
        const chunk = chunkRowSelected(data);
        const siblings = siblingChunksByKey.get(data.compositeKey) ?? [chunk];
        bridge.toggleChunk(data.compositeKey, chunk, nextChecked, siblings);
      }
    },
    [bridge, siblingChunksByKey]
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
              return <ChunkRow data={node.data} />;
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
      const target = openTargetForData(node.data);
      if (target === undefined) {
        onOpenFile(node.data.compositeKey);
        return;
      }
      onOpenFile(node.data.compositeKey, target);
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
      {notices?.candidatesTruncated && !notices.scanLimited ? (
        // scanLimited implies the candidate cap was hit (the grep service only
        // reports it at the cap), so showing both would double-report the same
        // limitation — the broader scanLimited notice wins.
        <p className="text-muted-foreground text-xs" role="status">
          Match list may be incomplete (candidate pool capped) — narrow the query.
        </p>
      ) : null}
      {fileKeys.length > 0 ? <SelectAllHeader bridge={bridge} fileKeys={fileKeys} /> : null}
      <div className="min-h-0 flex-1">
        <TreeTable<SearchNodeData>
          ariaRole="treegrid"
          autoWindowingContext="search"
          columns={columns}
          emptyState={<p className="p-3 text-muted-foreground text-sm">No matches found</p>}
          expandedIds={expandedIds}
          getCheckboxAriaLabel={getCheckboxAriaLabel}
          getCheckboxState={getCheckboxState}
          // Fill the scroll region (mirrors the Explorer tree) — the default
          // 600px cap would fight the panel's grid-rows-[auto_1fr_auto] middle.
          maxHeight="100%"
          nodes={nodes}
          nodesArePreFlattened
          onCheckboxChange={onCheckboxChange}
          onSelect={handleSelect}
          onToggleExpand={toggleExpanded}
          showHeader={false}
          windowingStrategy="auto"
        />
      </div>
      {notices?.truncated ? (
        // NO semantic paging: the Show-more affordance is text-mode only, even
        // if a caller passes onShowMore while semantic is active (defense in
        // depth — see the `truncated: false` comment in
        // workspace-search-executor.ts's buildSemanticResults).
        mode === 'text' && onShowMore ? (
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
