import {
  Badge,
  Button,
  Checkbox,
  type CheckboxState,
  type TreeNode,
  TreeTable,
  type TreeTableCheckboxNextState,
} from '@brainstrike/ui';
import { File as FileIcon, Paperclip } from 'lucide-react';
import type * as React from 'react';
import { useMemo } from 'react';
import type { WorkspaceSearchSummary } from '../core/search-result-model';
import { fileResultId, useWorkspaceSearchStore } from '../core/workspace-search-store';
import { buildSearchTreeNodes, type SearchNodeData } from './build-tree-nodes';

/** A search result file is either in the explorer selection or not. */
export type FileSelectionState = 'checked' | 'unchecked';

/**
 * The explorer selection the result checkboxes drive. The composition layer
 * supplies it, so a checked result is a selected explorer file.
 */
export interface SearchSelectionBridge {
  fileState: (compositeKey: string) => FileSelectionState;
  toggleFile: (compositeKey: string, nextChecked: boolean) => void;
}

/** A rendered headline/highlight fragment: plain text or an emphasized match. */
export type HeadlineSegment = string | { mark: string };

/**
 * Wraps literal occurrences of `query` inside `text` as mark segments. A match
 * carries no offsets, so the query is re-located in the line. When `query` is
 * empty the whole line is plain.
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

/** Where a row click navigates: a match row opens its line. */
export interface SearchOpenTarget {
  line: number;
}

interface RowRenderContext {
  caseSensitive: boolean;
  highlightEnabled: boolean;
  /** Attach a result file to the active thread; absent where nothing can read mentions (web). */
  onAttachFile?: ((compositeKey: string) => void) | undefined;
  query: string;
  rootName: (rootId: string) => string;
  showRootBadge: boolean;
}

function FileRow({
  data,
  ctx,
}: {
  data: Extract<SearchNodeData, { kind: 'file' }>;
  ctx: RowRenderContext;
}): React.ReactNode {
  const { compositeKey, file } = data;
  const { onAttachFile } = ctx;
  // The checkbox (the explorer selection) lives on TreeTable via the pluggable API.
  return (
    <span className="flex min-w-0 items-center gap-2">
      <FileIcon aria-hidden="true" className="text-muted-foreground h-4 w-4 shrink-0" />
      <span className="truncate text-sm font-medium" title={file.path}>
        {file.path}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {file.matches.length} {file.matches.length === 1 ? 'match' : 'matches'}
      </span>
      {ctx.showRootBadge ? (
        <Badge className="shrink-0" variant="secondary">
          {ctx.rootName(file.rootId)}
        </Badge>
      ) : null}
      {onAttachFile && compositeKey ? (
        <Button
          aria-label={`Attach ${file.path} to the thread`}
          className="ml-auto size-6 shrink-0"
          data-testid="search-attach-file"
          onClick={(event) => {
            // The row itself opens the file; the button only attaches it.
            event.stopPropagation();
            onAttachFile(compositeKey);
          }}
          size="icon-xs"
          title="Attach this file to the thread"
          variant="ghost"
        >
          <Paperclip aria-hidden="true" />
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Match row: a navigation-only leaf under its file, with the line number and
 * the highlighted line. Row click opens the file at that line.
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
      <span className="text-muted-foreground w-9 shrink-0 text-right font-mono text-xs tabular-nums">
        {match.line}
      </span>
      {/* A narrow panel truncates the line; its title keeps the whole line readable. */}
      <span className="text-foreground/80 truncate font-mono text-xs" title={match.lineText}>
        {content}
      </span>
    </span>
  );
}

/**
 * Rolls up the header tri-state from `fileState` over the currently rendered
 * (loaded) files only: all checked -> checked; some -> indeterminate; none ->
 * unchecked.
 */
function rollupSelectAllState(
  bridge: SearchSelectionBridge,
  fileKeys: readonly string[]
): FileSelectionState | 'indeterminate' {
  let checkedCount = 0;
  for (const key of fileKeys) {
    if (bridge.fileState(key) === 'checked') {
      checkedCount += 1;
    }
  }
  if (fileKeys.length > 0 && checkedCount === fileKeys.length) {
    return 'checked';
  }
  return checkedCount > 0 ? 'indeterminate' : 'unchecked';
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
  bridge: SearchSelectionBridge;
  fileKeys: readonly string[];
}): React.ReactNode {
  const state = rollupSelectAllState(bridge, fileKeys);
  const label = `Select ${fileKeys.length} shown`;

  const onToggle = () => {
    const nextChecked = state !== 'checked';
    for (const key of fileKeys) {
      bridge.toggleFile(key, nextChecked);
    }
  };

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
   * Attach a result file to the active thread as an `@file` mention. Absent
   * where nothing reads mentions (web): file rows then show no Attach button.
   */
  onAttachFile?: ((compositeKey: string) => void) | undefined;
  /** Row-click navigation: a match row passes its line; a file row passes none. */
  onOpenFile: (compositeKey: string, target?: SearchOpenTarget) => void;
  /** The name the Explorer shows for an open folder. */
  rootName: (rootId: string) => string;
  /** The explorer selection that file-row checkboxes read and write. */
  selection: SearchSelectionBridge;
  /**
   * Count of open workspace folders. With more than one, every file row shows
   * its folder badge, even when the matches happen to span one folder.
   */
  workspaceRootCount: number;
}

/** The caps a finished search hit, in words; nothing for a complete search. */
export function searchSummaryNotices(
  summary: WorkspaceSearchSummary | null,
  totalMatches: number,
  rootName: (rootId: string) => string
): string[] {
  if (!summary) {
    return [];
  }
  const notices: string[] = [];
  for (const rootId of summary.unreadableRootIds) {
    notices.push(`"${rootName(rootId)}" could not be read, so it was not searched.`);
  }
  if (summary.matchLimitReached) {
    notices.push(
      `Showing the first ${totalMatches.toLocaleString()} matches. Narrow the search to see the rest.`
    );
  }
  if (summary.timedOut) {
    notices.push('The search reached its time limit, so some files were not searched.');
  } else if (summary.scanLimited) {
    notices.push(
      'This pattern has no plain text to look for, so the search read files directly and stopped at its file limit.'
    );
  } else if (summary.candidatesTruncated) {
    notices.push(
      'The search stopped at its file limit, so some files were not searched. Narrow the search to reach the rest.'
    );
  }
  return notices;
}

/**
 * Results tree for workspace search, over the shared virtualized TreeTable.
 * Rows render as matches stream in. Row CLICK navigates; file checkboxes use
 * TreeTable's pluggable API (`getCheckboxState` / `onCheckboxChange`) to
 * select explorer files; match rows have none.
 */
export function SearchResultsTree({
  onAttachFile,
  onOpenFile,
  rootName,
  selection: bridge,
  workspaceRootCount,
}: SearchResultsTreeProps): React.ReactNode {
  const files = useWorkspaceSearchStore((state) => state.files);
  const summary = useWorkspaceSearchStore((state) => state.summary);
  const totalMatches = useWorkspaceSearchStore((state) => state.totalMatches);
  const query = useWorkspaceSearchStore((state) => state.query);
  const isRegex = useWorkspaceSearchStore((state) => state.isRegex);
  const caseSensitive = useWorkspaceSearchStore((state) => state.caseSensitive);
  const collapsedIds = useWorkspaceSearchStore((state) => state.collapsedIds);
  const toggleCollapsed = useWorkspaceSearchStore((state) => state.toggleCollapsed);

  const nodes = useMemo(() => buildSearchTreeNodes({ collapsedIds, files }), [collapsedIds, files]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const expandedIds = useMemo(
    () => new Set(files.map(fileResultId).filter((id) => !collapsedIds.has(id))),
    [collapsedIds, files]
  );
  const fileKeys = useMemo(
    () => files.map((file) => nodeById.get(fileResultId(file))?.data.compositeKey ?? ''),
    [files, nodeById]
  );
  // Badge whenever the workspace has several folders (the user needs
  // attribution even for a one-folder result set), or the results span several.
  const showRootBadge =
    workspaceRootCount > 1 || new Set(files.map((file) => file.rootId)).size > 1;

  const ctx: RowRenderContext = {
    caseSensitive,
    highlightEnabled: !isRegex,
    onAttachFile,
    query: query.trim(),
    rootName,
    showRootBadge,
  };

  const getCheckboxState = (node: TreeNode<SearchNodeData>): CheckboxState | 'hidden' =>
    node.data.kind === 'file' ? bridge.fileState(node.data.compositeKey) : 'hidden';

  const getCheckboxAriaLabel = (node: TreeNode<SearchNodeData>): string | undefined =>
    node.data.kind === 'file' ? `Select ${node.data.file.path}` : undefined;

  const onCheckboxChange = (
    node: TreeNode<SearchNodeData>,
    nextState: TreeTableCheckboxNextState
  ) => {
    if (node.data.kind === 'file') {
      bridge.toggleFile(node.data.compositeKey, nextState === 'checked');
    }
  };

  const columns = [
    {
      cell: ({ node }: { node: TreeNode<SearchNodeData> }) =>
        node.data.kind === 'file' ? (
          <FileRow ctx={ctx} data={node.data} />
        ) : (
          <MatchRow ctx={ctx} data={node.data} />
        ),
      header: 'Results',
      id: 'result',
      reserveToggleSpace: true,
    },
  ];

  const handleSelect = (nodeId: string | null) => {
    const node = nodeId === null ? undefined : nodeById.get(nodeId);
    if (!node) {
      return;
    }
    if (node.data.kind === 'file') {
      onOpenFile(node.data.compositeKey);
      return;
    }
    onOpenFile(node.data.compositeKey, { line: node.data.match.line });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      {searchSummaryNotices(summary, totalMatches, rootName).map((notice) => (
        <p className="text-muted-foreground text-xs" key={notice} role="status">
          {notice}
        </p>
      ))}
      {fileKeys.length > 0 ? <SelectAllHeader bridge={bridge} fileKeys={fileKeys} /> : null}
      <div className="min-h-0 flex-1">
        <TreeTable<SearchNodeData>
          ariaRole="treegrid"
          autoWindowingContext="search"
          columns={columns}
          emptyState={<p className="text-muted-foreground p-3 text-sm">No matches found</p>}
          expandedIds={expandedIds}
          getCheckboxAriaLabel={getCheckboxAriaLabel}
          getCheckboxState={getCheckboxState}
          // Fill the scroll region (mirrors the Explorer tree): the default
          // 600px cap would fight the panel's grid rows.
          maxHeight="100%"
          nodes={nodes}
          nodesArePreFlattened
          onCheckboxChange={onCheckboxChange}
          onSelect={handleSelect}
          onToggleExpand={toggleCollapsed}
          showHeader={false}
          windowingStrategy="auto"
        />
      </div>
    </div>
  );
}
