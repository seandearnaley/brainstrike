import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSearchHit, WorkspaceSearchSummary } from '../../core/search-result-model';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import {
  type FileSelectionState,
  highlightQuery,
  SearchResultsTree,
  type SearchResultsTreeProps,
  type SearchSelectionBridge,
  searchSummaryNotices,
} from '../search-results-tree';

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
  fileState: vi.fn((): FileSelectionState => 'unchecked'),
  toggleFile: vi.fn(),
};

const ROOT_NAMES: Record<string, string> = { 'root-a': 'Root A', 'root-b': 'Root B' };

/** The tree wired to the mock explorer selection, with test defaults. */
function Tree(props: Partial<SearchResultsTreeProps>) {
  return (
    <SearchResultsTree
      onOpenFile={vi.fn()}
      rootName={(rootId) => ROOT_NAMES[rootId] ?? rootId}
      selection={bridgeMock}
      workspaceRootCount={1}
      {...props}
    />
  );
}

const hit = (overrides: Partial<WorkspaceSearchHit> = {}): WorkspaceSearchHit => ({
  line: 10,
  lineText: 'const foo = 1;',
  path: 'src/a.ts',
  rootId: 'root-a',
  ...overrides,
});

const COMPLETE: WorkspaceSearchSummary = {
  candidatesTruncated: false,
  matchLimitReached: false,
  scanLimited: false,
  timedOut: false,
  unreadableRootIds: [],
};

/** A finished search that found `hits`, for `query`. */
function finishedSearch(
  hits: readonly WorkspaceSearchHit[],
  options: { query?: string; summary?: Partial<WorkspaceSearchSummary> } = {}
): void {
  const store = useWorkspaceSearchStore.getState();
  store.setQuery(options.query ?? '');
  const generation = store.beginSearch();
  store.appendMatches(hits, generation);
  store.completeSearch({ ...COMPLETE, ...options.summary }, generation);
}

const keyOf = (rootId: string, path: string) => encodeFileSelection(rootId, path);

beforeEach(() => {
  vi.clearAllMocks();
  (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockReturnValue('unchecked');
  useWorkspaceSearchStore.getState().reset();
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
    expect(highlightQuery('const x', '', false)).toEqual(['const x']);
  });
});

describe('SearchResultsTree', () => {
  it('shows each file with its match count, then its matching lines', () => {
    finishedSearch([
      hit({ line: 3, lineText: 'first foo' }),
      hit({ line: 9, lineText: 'second foo' }),
    ]);
    render(<Tree />);
    expect(screen.getByRole('treegrid')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('2 matches')).toBeInTheDocument();
    expect(screen.getByText('first foo')).toBeInTheDocument();
    expect(screen.getByText('second foo')).toBeInTheDocument();
  });

  it('hides a file’s lines when the user collapses it', () => {
    finishedSearch([hit({ lineText: 'hidden line' })]);
    useWorkspaceSearchStore.getState().toggleCollapsed('f:root-a:src/a.ts');
    render(<Tree />);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.queryByText('hidden line')).not.toBeInTheDocument();
  });

  it('shows folder badges when the matches span folders, or the workspace has several', () => {
    finishedSearch([hit()]);
    const single = render(<Tree />);
    expect(single.queryByText('Root A')).not.toBeInTheDocument();
    single.unmount();

    render(<Tree workspaceRootCount={2} />);
    expect(screen.getByText('Root A')).toBeInTheDocument();
  });

  it('names both folders when the same path matches in each', () => {
    finishedSearch([hit({ rootId: 'root-a' }), hit({ rootId: 'root-b' })]);
    render(<Tree />);
    expect(screen.getAllByText('src/a.ts')).toHaveLength(2);
    expect(screen.getByText('Root A')).toBeInTheDocument();
    expect(screen.getByText('Root B')).toBeInTheDocument();
  });

  it('highlights the query in a matching line, but not for a regular expression', () => {
    finishedSearch([hit({ lineText: 'const foo = 1;' })], { query: 'foo' });
    const plain = render(<Tree />);
    expect(screen.getAllByText('foo', { selector: 'mark' }).length).toBeGreaterThan(0);
    plain.unmount();

    useWorkspaceSearchStore.getState().toggleRegex();
    finishedSearch([hit({ lineText: 'const foo = 1;' })], { query: 'fo+' });
    render(<Tree />);
    expect(screen.queryByText('foo', { selector: 'mark' })).not.toBeInTheDocument();
  });

  it('names a truncated match line and file path in full (BST-1981: a narrow panel cuts them off)', () => {
    const lineText = 'The zebra crossing outside the station is closed for repairs today.';
    finishedSearch([hit({ lineText })], { query: 'zebra' });
    render(<Tree />);
    expect(screen.getByTitle(lineText)).toHaveTextContent(lineText);
    expect(screen.getByTitle('src/a.ts')).toHaveTextContent('src/a.ts');
  });

  it('opens the file at the matching line when a line is clicked, and at the top for a file row', () => {
    const onOpenFile = vi.fn();
    finishedSearch([hit({ line: 10 })]);
    render(<Tree onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByText('const foo = 1;'));
    expect(onOpenFile).toHaveBeenLastCalledWith(keyOf('root-a', 'src/a.ts'), { line: 10 });
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(onOpenFile).toHaveBeenLastCalledWith(keyOf('root-a', 'src/a.ts'));
  });

  it('selects a file in the Explorer from its checkbox, without opening it', () => {
    const onOpenFile = vi.fn();
    finishedSearch([hit(), hit({ line: 11 })]);
    render(<Tree onOpenFile={onOpenFile} />);
    // The select-all header and the one file row: match lines have no checkbox.
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[1] as HTMLElement);
    expect(bridgeMock.toggleFile).toHaveBeenCalledExactlyOnceWith(
      keyOf('root-a', 'src/a.ts'),
      true
    );
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('attaches a result file from its row without opening it, where attaching is offered', () => {
    const onAttachFile = vi.fn();
    const onOpenFile = vi.fn();
    finishedSearch([hit()]);
    const { rerender } = render(<Tree onAttachFile={onAttachFile} onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach src/a.ts to the thread' }));
    expect(onAttachFile).toHaveBeenCalledExactlyOnceWith(keyOf('root-a', 'src/a.ts'));
    expect(onOpenFile).not.toHaveBeenCalled();

    // Web reads no mentions: no attach button at all.
    rerender(<Tree onOpenFile={onOpenFile} />);
    expect(screen.queryByTestId('search-attach-file')).toBeNull();
  });

  it('says when the search found nothing', () => {
    finishedSearch([]);
    render(<Tree />);
    expect(screen.getByText('No matches found')).toBeInTheDocument();
  });

  it('names every cap the finished search hit', () => {
    finishedSearch([hit()], {
      summary: { matchLimitReached: true, unreadableRootIds: ['root-b'] },
    });
    render(<Tree />);
    expect(
      screen.getByText('"Root B" could not be read, so it was not searched.')
    ).toBeInTheDocument();
    expect(screen.getByText(/Narrow the search to see the rest\./u)).toBeInTheDocument();
  });
});

describe('searchSummaryNotices', () => {
  const name = (rootId: string) => rootId;

  it('says nothing for a complete search, or one still running', () => {
    expect(searchSummaryNotices(COMPLETE, 3, name)).toEqual([]);
    expect(searchSummaryNotices(null, 3, name)).toEqual([]);
  });

  it('names the file cap, and a timeout in its place', () => {
    expect(searchSummaryNotices({ ...COMPLETE, candidatesTruncated: true }, 3, name)).toEqual([
      'The search stopped at its file limit, so some files were not searched. Narrow the search to reach the rest.',
    ]);
    expect(
      searchSummaryNotices({ ...COMPLETE, candidatesTruncated: true, timedOut: true }, 3, name)
    ).toEqual(['The search reached its time limit, so some files were not searched.']);
  });

  it('explains a regular expression with no plain text that stopped at the file cap', () => {
    expect(
      searchSummaryNotices({ ...COMPLETE, candidatesTruncated: true, scanLimited: true }, 3, name)
    ).toEqual([
      'This pattern has no plain text to look for, so the search read files directly and stopped at its file limit.',
    ]);
  });

  it('formats the match cap for the reader', () => {
    expect(searchSummaryNotices({ ...COMPLETE, matchLimitReached: true }, 5000, name)).toEqual([
      'Showing the first 5,000 matches. Narrow the search to see the rest.',
    ]);
  });
});

describe('SearchResultsTree select-all header', () => {
  const twoFiles = () =>
    finishedSearch([hit({ path: 'src/a.ts' }), hit({ path: 'src/b.ts', rootId: 'root-b' })]);

  it('labels itself with the number of files shown', () => {
    twoFiles();
    render(<Tree />);
    expect(screen.getByRole('checkbox', { name: 'Select 2 shown' })).toBeInTheDocument();
  });

  it('renders no header when nothing matched', () => {
    finishedSearch([]);
    render(<Tree />);
    expect(screen.queryByRole('checkbox', { name: /Select .* shown/u })).not.toBeInTheDocument();
  });

  it('reads checked, indeterminate or unchecked from the files shown', () => {
    twoFiles();
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string): FileSelectionState => (key.endsWith('src/a.ts') ? 'checked' : 'unchecked')
    );
    const some = render(<Tree />);
    expect(screen.getByRole('checkbox', { name: 'Select 2 shown' })).toHaveAttribute(
      'data-state',
      'indeterminate'
    );
    some.unmount();

    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockReturnValue('checked');
    render(<Tree />);
    expect(screen.getByRole('checkbox', { name: 'Select 2 shown' })).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  it('selects every file shown, or clears them all when all are selected', () => {
    twoFiles();
    const unchecked = render(<Tree />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select 2 shown' }));
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith(keyOf('root-a', 'src/a.ts'), true);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith(keyOf('root-b', 'src/b.ts'), true);
    unchecked.unmount();

    vi.clearAllMocks();
    (bridgeMock.fileState as ReturnType<typeof vi.fn>).mockReturnValue('checked');
    render(<Tree />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select 2 shown' }));
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith(keyOf('root-a', 'src/a.ts'), false);
    expect(bridgeMock.toggleFile).toHaveBeenCalledWith(keyOf('root-b', 'src/b.ts'), false);
  });
});
