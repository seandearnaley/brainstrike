import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverageState } from '../../bridge/range-math';
import type { SearchSelectionBridge } from '../../bridge/use-search-selection-bridge';
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
  chunkState: vi.fn((): CoverageState => 'unchecked'),
  isFileChecked: vi.fn(() => false),
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

function seedResults(
  results: WorkspaceSearchResults,
  patch: Partial<ReturnType<typeof useWorkspaceSearchStore.getState>> = {}
): void {
  useWorkspaceSearchStore.setState({
    expandedIds: new Set(results.files.map((f) => `f:${f.dbRootId}:${f.path}`)),
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
    (bridgeMock.isFileChecked as ReturnType<typeof vi.fn>).mockReturnValue(false);
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
    expect(onOpenFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', 10);
  });

  it('navigates on chunk row click passing startLine', () => {
    const onOpenFile = vi.fn();
    seedResults(makeResults([fileResult({ children: [chunkHit({ startLine: 14 })] })]), {
      mode: 'semantic',
    });
    render(
      <SearchResultsTree onOpenFile={onOpenFile} resolveAdapterRootId={resolveAdapterRootId} />
    );
    fireEvent.click(screen.getByText('beta', { selector: 'mark' }));
    expect(onOpenFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', 14);
  });

  it('toggles the bridge (not navigation) when a checkbox is clicked', () => {
    const onOpenFile = vi.fn();
    seedResults(makeResults([fileResult({ children: [textMatch()] })]));
    render(
      <SearchResultsTree onOpenFile={onOpenFile} resolveAdapterRootId={resolveAdapterRootId} />
    );
    const [fileCheckbox] = screen.getAllByRole('checkbox');
    fireEvent.click(fileCheckbox as HTMLElement);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith('adapter-root-mounted|@|src/a.ts', true);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('toggles a chunk range via the bridge from a child checkbox', () => {
    seedResults(
      makeResults([fileResult({ children: [textMatch({ chunkEndLine: 12, chunkStartLine: 8 })] })])
    );
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // [0] is the file row, [1] is the child row.
    fireEvent.click(checkboxes[1] as HTMLElement);
    expect(bridgeMock.toggleChunk).toHaveBeenCalledWith(
      'adapter-root-mounted|@|src/a.ts',
      { endLine: 12, startLine: 8 },
      true
    );
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

  it('renders the missing-line-metadata notice with a count', () => {
    seedResults(makeResults([fileResult()], { skippedMissingLineMetadata: 3 }));
    render(<SearchResultsTree onOpenFile={vi.fn()} resolveAdapterRootId={resolveAdapterRootId} />);
    expect(screen.getByText('3 results need a rebuilt index')).toBeInTheDocument();
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
