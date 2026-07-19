import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChunkSelectionState,
  FileSelectionState,
  SearchSelectionBridge,
} from '../../bridge/use-search-selection-bridge';
import type {
  WorkspaceSearchChunkHit,
  WorkspaceSearchFileResult,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from '../../core/search-result-model';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';

// Render every virtual row headlessly (happy-dom has no layout dimensions).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        end: (i + 1) * 40,
        index: i,
        key: `item-${i}`,
        size: 40,
        start: i * 40,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  })),
}));

const bridgeMock: SearchSelectionBridge = {
  chunkState: vi.fn((): ChunkSelectionState => 'unchecked'),
  fileState: vi.fn((): FileSelectionState => 'unchecked'),
  toggleChunk: vi.fn(),
  toggleFile: vi.fn(),
};
vi.mock('../../bridge/use-search-selection-bridge', () => ({
  useSearchSelectionBridge: () => bridgeMock,
}));

import { highlightQuery, SearchResultsTree, splitHeadline } from '../search-results-tree';

const resolveAdapterRootId = (dbRootId: string): string | null =>
  dbRootId === 'root-unmounted' ? null : `adapter-${dbRootId}`;

function textMatch(overrides: Partial<WorkspaceSearchTextMatch> = {}): WorkspaceSearchTextMatch {
  return {
    after: [],
    before: [],
    chunkEndLine: 12,
    chunkId: 'chunk-1',
    chunkStartLine: 8,
    kind: 'match',
    line: 10,
    lineText: 'const foo = 1;',
    provenance: 'index',
    ...overrides,
  };
}

function chunkHit(overrides: Partial<WorkspaceSearchChunkHit> = {}): WorkspaceSearchChunkHit {
  return {
    chunkId: 'chunk-9',
    content: 'plain chunk content',
    endLine: 20,
    headline: 'alpha <mark>beta</mark> gamma',
    kind: 'chunk',
    provenance: 'index',
    score: 0.5,
    startLine: 14,
    tokenCount: 42,
    ...overrides,
  };
}

function fileResult(overrides: Partial<WorkspaceSearchFileResult> = {}): WorkspaceSearchFileResult {
  return {
    children: [textMatch()],
    dbRootId: 'root-mounted',
    path: 'src/a.ts',
    rootDisplayName: 'Mounted Root',
    ...overrides,
  };
}

function makeResults(
  files: WorkspaceSearchFileResult[],
  notices: Partial<WorkspaceSearchResults['notices']> = {}
): WorkspaceSearchResults {
  return {
    files,
    mode: 'text',
    notices: {
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      truncated: false,
      ...notices,
    },
    totalMatches: files.reduce((n, f) => n + f.children.length, 0),
  };
}

/** Mirror the store's default expansion: file ids + text-mode chunk-group ids. */
function defaultExpandedIds(results: WorkspaceSearchResults): Set<string> {
  const ids = new Set<string>();
  for (const f of results.files) {
    ids.add(`f:${f.dbRootId}:${f.path}`);
    for (const child of f.children) {
      if (child.kind === 'match') {
        ids.add(`c:${child.chunkId}`);
      }
    }
  }
  return ids;
}

function seedResults(
  results: WorkspaceSearchResults,
  patch: Partial<ReturnType<typeof useWorkspaceSearchStore.getState>> = {}
): void {
  useWorkspaceSearchStore.setState({
    expandedIds: defaultExpandedIds(results),
    mode: 'text',
    query: '',
    results,
    status: 'results',
    ...patch,
  });
}

describe('splitHeadline', () => {
  it('tokenizes literal <mark> segments', () => {
    expect(splitHeadline('a <mark>b</mark> c')).toEqual(['a ', { mark: 'b' }, ' c']);
  });

  it('returns a single text segment when there are no marks', () => {
    expect(splitHeadline('plain text')).toEqual(['plain text']);
  });
});

describe('highlightQuery', () => {
  it('wraps case-insensitive query occurrences as mark segments', () => {
    expect(highlightQuery('Foo and foo', 'foo', false)).toEqual([
      { mark: 'Foo' },
      ' and ',
      { mark: 'foo' },
    ]);
  });

  it('returns the whole line when query is empty', () => {
    expect(highlightQuery('anything', '', false)).toEqual(['anything']);
  });
});

describe('SearchResultsTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockReturnValue('unchecked');
    (bridgeMock.chunkState as ReturnType<typeof vi.fn>).mockReturnValue('unchecked');
    useWorkspaceSearchStore.getState().reset();
  });

  it('renders a treegrid with rows for the pre-flattened result model', () => {
    seedResults(makeResults([fileResult()]));
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(screen.getByRole('treegrid')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('shows the root badge only when results span more than one distinct root', () => {
    seedResults(makeResults([fileResult({ path: 'src/a.ts' })]));
    const single = render(
      <SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />
    );
    expect(single.queryByText('Mounted Root')).not.toBeInTheDocument();
    single.unmount();

    seedResults(
      makeResults([
        fileResult({ dbRootId: 'root-a', path: 'src/a.ts', rootDisplayName: 'Root A' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts', rootDisplayName: 'Root B' }),
      ])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(screen.getByText('Root A')).toBeInTheDocument();
    expect(screen.getByText('Root B')).toBeInTheDocument();
  });

  it('shows the root badge for single-root results when the workspace mounts multiple roots', () => {
    // A multi-root ("forest") workspace must always attribute results to their
    // root — even when the current result set happens to come from one root,
    // the user cannot know which root that is without the badge.
    seedResults(makeResults([fileResult({ path: 'src/a.ts' })]));
    render(
      <SearchResultsTree
        onOpenFile={vi.fn()}
        resolveAdapterRootId={resolveAdapterRootId}
        workspaceRootCount={2}
      />
    );
    expect(screen.getByText('Mounted Root')).toBeInTheDocument();
  });

  it('hides the root badge for single-root results in a single-root workspace', () => {
    seedResults(makeResults([fileResult({ path: 'src/a.ts' })]));
    render(
      <SearchResultsTree
        onOpenFile={vi.fn()}
        resolveAdapterRootId={resolveAdapterRootId}
        workspaceRootCount={1}
      />
    );
    expect(screen.queryByText('Mounted Root')).not.toBeInTheDocument();
  });

  it('highlights the query substring on text-match rows', () => {
    seedResults(
      makeResults([fileResult({ children: [textMatch({ lineText: 'const foo = 1;' })] })]),
      {
        query: 'foo',
      }
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const marks = screen.getAllByText('foo', { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
  });

  it('renders ts_headline marks as <mark> elements without dangerouslySetInnerHTML', () => {
    seedResults(makeResults([fileResult({ children: [chunkHit()] })]), { mode: 'semantic' });
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(screen.getByText('beta', { selector: 'mark' })).toBeInTheDocument();
    // The literal tag text must never reach the DOM.
    expect(screen.queryByText(/<mark>/)).not.toBeInTheDocument();
  });

  it('navigates on row click: match rows pass their line', () => {
    const onOpenFile = vi.fn();
    seedResults(makeResults([fileResult({ children: [textMatch({ line: 10 })] })]));
    render(
      <SearchResultsTree onOpenFile={onOpenFile} resolveAdapterRootId={resolveAdapterRootId} />
    );
    fireEvent.click(screen.getByText('const foo = 1;'));
    // Match rows navigate to the line only (no selection range).
    expect(onOpenFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', { line: 10 });
  });

  it('navigates on chunk row click passing the chunk range to select', () => {
    const onOpenFile = vi.fn();
    seedResults(
      makeResults([fileResult({ children: [chunkHit({ endLine: 20, startLine: 14 })] })]),
      {
        mode: 'semantic',
      }
    );
    render(
      <SearchResultsTree onOpenFile={onOpenFile} resolveAdapterRootId={resolveAdapterRootId} />
    );
    fireEvent.click(screen.getByText('beta', { selector: 'mark' }));
    // Chunk rows scroll to startLine AND select the full chunk range so the
    // opened file highlights the block, ready to copy.
    expect(onOpenFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', {
      line: 14,
      selection: { endLine: 20, startLine: 14 },
    });
  });

  it('toggles the bridge (not navigation) when a checkbox is clicked', () => {
    const onOpenFile = vi.fn();
    seedResults(makeResults([fileResult({ children: [textMatch()] })]));
    render(
      <SearchResultsTree onOpenFile={onOpenFile} resolveAdapterRootId={resolveAdapterRootId} />
    );
    // [0] is the select-all header checkbox; [1] is the file row checkbox.
    const [, fileCheckbox] = screen.getAllByRole('checkbox');
    fireEvent.click(fileCheckbox as HTMLElement);
    expect(bridgeMock.toggleFile).toHaveBeenCalledTimes(1);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', true);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('toggles a chunk range via the bridge from the chunk checkbox', () => {
    seedResults(
      makeResults([fileResult({ children: [textMatch({ chunkEndLine: 12, chunkStartLine: 8 })] })])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // [0] is the select-all header, [1] is the file row, [2] is the chunk row;
    // match rows carry NO checkbox.
    fireEvent.click(checkboxes[2] as HTMLElement);
    expect(bridgeMock.toggleChunk).toHaveBeenCalledTimes(1);
    expect(bridgeMock.toggleChunk).toHaveBeenCalledWith(
      'adapter-root-mounted|@|src/a.ts',
      { chunkId: 'chunk-1', endLine: 12, startLine: 8 },
      true,
      // Sibling result-chunk list threaded from the tree (this file has one chunk).
      [{ chunkId: 'chunk-1', endLine: 12, startLine: 8 }]
    );
  });

  it('puts the checkbox on the chunk row (aria-label Select lines X-Y), never on match rows', () => {
    seedResults(
      makeResults([
        fileResult({
          children: [
            textMatch({ chunkEndLine: 12, chunkId: 'chunk-1', chunkStartLine: 8, line: 9 }),
            textMatch({ chunkEndLine: 12, chunkId: 'chunk-1', chunkStartLine: 8, line: 11 }),
          ],
        }),
      ])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    // select-all header + file checkbox + ONE chunk checkbox — two matches
    // share one chunk.
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: 'Select lines 8-12' })).toBeInTheDocument();
  });

  it('renders the "· N matches" chunk label only when N > 1', () => {
    seedResults(
      makeResults([
        fileResult({
          children: [
            textMatch({ chunkId: 'chunk-1', line: 9 }),
            textMatch({ chunkId: 'chunk-1', line: 11 }),
          ],
          path: 'src/multi.ts',
        }),
      ])
    );
    const multi = render(
      <SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />
    );
    expect(multi.getByText(/· 2 matches/)).toBeInTheDocument();
    multi.unmount();

    seedResults(
      makeResults([fileResult({ children: [textMatch({ chunkId: 'chunk-1', line: 9 })] })])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(screen.queryByText(/matches/)).not.toBeInTheDocument();
  });

  it('navigates to the chunk startLine and selects the range when a text chunk row is clicked', () => {
    const onOpenFile = vi.fn();
    seedResults(
      makeResults([
        fileResult({
          children: [textMatch({ chunkEndLine: 12, chunkStartLine: 8, line: 10 })],
          path: 'src/a.ts',
        }),
      ])
    );
    render(
      <SearchResultsTree onOpenFile={onOpenFile} resolveAdapterRootId={resolveAdapterRootId} />
    );
    fireEvent.click(screen.getByText(/Lines 8–/));
    expect(onOpenFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', {
      line: 8,
      selection: { endLine: 12, startLine: 8 },
    });
  });

  it('renders the scanLimited notice', () => {
    seedResults(makeResults([fileResult()], { scanLimited: true }));
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(screen.getByText('Broad pattern — results limited')).toBeInTheDocument();
  });

  it('renders a Show more button for truncated results when onShowMore is provided', () => {
    const onShowMore = vi.fn();
    seedResults(makeResults([fileResult()], { truncated: true }));
    render(
      <SearchResultsTree
        onOpenFile={vi.fn()}
        onShowMore={onShowMore}
        resolveAdapterRootId={resolveAdapterRootId}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it('states the honest limit (no false "Show more") for truncated results without onShowMore', () => {
    seedResults(makeResults([fileResult()], { truncated: true }));
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    // One match row rendered -> "first 1 matches"; no clickable affordance.
    expect(screen.getByText('Results limited to first 1 matches')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('never shows "Show more" in semantic mode even when onShowMore is passed (no semantic paging)', () => {
    const onShowMore = vi.fn();
    // Semantic truncated is always false in real results, but the tree itself
    // must not render a semantic paging affordance even if a caller mistakenly
    // wires onShowMore + a hypothetical truncated notice through.
    seedResults(makeResults([fileResult({ children: [chunkHit()] })], { truncated: true }), {
      mode: 'semantic',
    });
    render(
      <SearchResultsTree
        onOpenFile={vi.fn()}
        onShowMore={onShowMore}
        resolveAdapterRootId={resolveAdapterRootId}
      />
    );
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    // The honest fallback copy still renders instead.
    expect(screen.getByText(/Results limited to first/)).toBeInTheDocument();
  });

  it('renders the missing-line-metadata notice with a count and honest cause copy', () => {
    seedResults(makeResults([fileResult()], { skippedMissingLineMetadata: 3 }));
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(
      screen.getByText(
        '3 results hidden (stale or unattributed index rows — reindexing fixes this)'
      )
    ).toBeInTheDocument();
  });

  it('renders the candidatesTruncated notice', () => {
    seedResults(makeResults([fileResult()], { candidatesTruncated: true }));
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(
      screen.getByText('Match list may be incomplete (candidate pool capped) — narrow the query.')
    ).toBeInTheDocument();
  });

  it('aligns file/chunk checkboxes per level: chunk rows indent further AND reserve toggle space (semantic)', () => {
    // Semantic mode: file (depth 0, has a child chunk) → chunk (depth 1, LEAF).
    seedResults(makeResults([fileResult({ children: [chunkHit()] })]), { mode: 'semantic' });
    const { container } = render(
      <SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />
    );

    const fileRow = container.querySelector('[data-depth="0"]');
    const chunkRow = container.querySelector('[data-depth="1"]');
    expect(fileRow).not.toBeNull();
    expect(chunkRow).not.toBeNull();

    // Per-level indent: the chunk row (depth 1) sits deeper than the file row.
    expect(Number(chunkRow?.getAttribute('data-depth'))).toBeGreaterThan(
      Number(fileRow?.getAttribute('data-depth'))
    );

    // The leaf chunk row RESERVES the expand-toggle column (the h-7 w-7 spacer)
    // so its checkbox lines up under the file's checkbox instead of the reported
    // regression where it landed left of it. Removing reserveToggleSpace:false
    // is what restores this spacer.
    expect(chunkRow?.querySelector('span.h-7.w-7')).not.toBeNull();
  });

  it('passes the search windowing context to the tree', () => {
    seedResults(makeResults([fileResult()]));
    const { container } = render(
      <SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />
    );
    const grid = within(container).getByRole('treegrid');
    expect(grid).toBeInTheDocument();
  });
});

describe('SearchResultsTree select-all header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockReturnValue('unchecked');
    (bridgeMock.chunkState as ReturnType<typeof vi.fn>).mockReturnValue('unchecked');
    useWorkspaceSearchStore.getState().reset();
  });

  it('renders with the exact "Select {N} shown" label/aria-label for N loaded files', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts' }),
      ])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const header = screen.getByRole('checkbox', { name: 'Select 2 shown' });
    expect(header).toBeInTheDocument();
    expect(screen.getByText('Select 2 shown')).toBeInTheDocument();
  });

  it('renders no header when zero files are rendered', () => {
    seedResults(makeResults([]));
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(screen.queryByRole('checkbox', { name: /Select .* shown/ })).not.toBeInTheDocument();
  });

  it('reads checked when every rendered file is checked', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts' }),
      ])
    );
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockReturnValue('checked');
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const header = screen.getByRole('checkbox', { name: 'Select 2 shown' });
    expect(header).toHaveAttribute('data-state', 'checked');
  });

  it('reads indeterminate when some but not all rendered files are checked', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts' }),
      ])
    );
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string): FileSelectionState => (key.endsWith('src/a.ts') ? 'checked' : 'unchecked')
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const header = screen.getByRole('checkbox', { name: 'Select 2 shown' });
    expect(header).toHaveAttribute('data-state', 'indeterminate');
  });

  it('counts a chunk-refined file (fileState "indeterminate") as "some" -> header indeterminate', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts' }),
      ])
    );
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string): FileSelectionState =>
        key.endsWith('src/a.ts') ? 'indeterminate' : 'unchecked'
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const header = screen.getByRole('checkbox', { name: 'Select 2 shown' });
    expect(header).toHaveAttribute('data-state', 'indeterminate');
  });

  it('reads unchecked when no rendered file is selected', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts' }),
      ])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const header = screen.getByRole('checkbox', { name: 'Select 2 shown' });
    expect(header).toHaveAttribute('data-state', 'unchecked');
  });

  it('clicking while unchecked/indeterminate calls toggleFile(key, true) for every rendered file', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts' }),
      ])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select 2 shown' }));
    expect(bridgeMock.toggleFile).toHaveBeenCalledTimes(2);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', true);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith('adapter-root-b|@|src/b.ts', true);
  });

  it('clicking while checked calls toggleFile(key, false) for every rendered file', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-b', path: 'src/b.ts' }),
      ])
    );
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockReturnValue('checked');
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select 2 shown' }));
    expect(bridgeMock.toggleFile).toHaveBeenCalledTimes(2);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', false);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith('adapter-root-b|@|src/b.ts', false);
  });

  it('never touches files whose root is unmounted (omitted from the rendered set)', () => {
    seedResults(
      makeResults([
        fileResult({ path: 'src/a.ts' }),
        fileResult({ dbRootId: 'root-unmounted', path: 'src/unmounted.ts' }),
      ])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    // Only 1 file is actually rendered/loaded (the unmounted-root file is omitted).
    const header = screen.getByRole('checkbox', { name: 'Select 1 shown' });
    fireEvent.click(header);
    expect(bridgeMock.toggleFile).toHaveBeenCalledTimes(1);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', true);
  });
});
