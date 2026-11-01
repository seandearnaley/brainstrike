import { act } from '@brainstrike/test-utils/react-act';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSearchHit } from '../../core/search-result-model';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import type { FileSelectionState, SearchSelectionBridge } from '../search-results-tree';
import { WorkspaceSearchPanel } from '../workspace-search-panel';

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

const HIT: WorkspaceSearchHit = {
  line: 10,
  lineText: 'const foo = 1;',
  path: 'src/a.ts',
  rootId: 'root-a',
};

const SUMMARY = {
  candidatesTruncated: false,
  matchLimitReached: false,
  scanLimited: false,
  timedOut: false,
  unreadableRootIds: [],
};

/** Starts a search in the store and streams `hits` into it; returns its generation. */
function streamHits(hits: readonly WorkspaceSearchHit[]): number {
  const store = useWorkspaceSearchStore.getState();
  const generation = store.beginSearch();
  store.appendMatches(hits, generation);
  return generation;
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof WorkspaceSearchPanel>> = {}) {
  const props = {
    onOpenFile: vi.fn(),
    rootName: (rootId: string) => (rootId === 'root-a' ? 'Root A' : rootId),
    runSearch: vi.fn(),
    selection: bridgeMock,
    workspaceRootCount: 1,
    ...overrides,
  };
  return { ...render(<WorkspaceSearchPanel {...props} />), props };
}

/** The panel's search-as-you-type debounce, plus slack. */
const DEBOUNCE_ADVANCE = 150;

describe('WorkspaceSearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceSearchStore.getState().reset();
  });

  it('shows the idle empty state before any search', () => {
    renderPanel();
    expect(screen.getByText("Search the text of your workspace's files.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Semantic' })).not.toBeInTheDocument();
  });

  it('shows a searching indicator until the first match arrives', () => {
    act(() => {
      useWorkspaceSearchStore.getState().beginSearch();
    });
    renderPanel();
    expect(screen.getByText('Searching…')).toBeInTheDocument();
    expect(screen.queryByRole('treegrid')).not.toBeInTheDocument();
  });

  it('shows matches while the search is still running, and says it is still searching', () => {
    act(() => {
      streamHits([HIT]);
    });
    renderPanel();
    expect(screen.getByRole('treegrid')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-search-streaming')).toHaveTextContent('Searching…');
  });

  it('drops the searching status once the search finishes', () => {
    act(() => {
      const generation = streamHits([HIT]);
      useWorkspaceSearchStore.getState().completeSearch(SUMMARY, generation);
    });
    renderPanel();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-search-streaming')).not.toBeInTheDocument();
  });

  it('shows the error card with the message and re-runs on Retry', () => {
    act(() => {
      const generation = useWorkspaceSearchStore.getState().beginSearch();
      useWorkspaceSearchStore.getState().failSearch('Boom', generation);
    });
    const { props } = renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.runSearch).toHaveBeenCalledTimes(1);
  });

  it('shows folder badges in a multi-folder workspace even when every match is in one', () => {
    act(() => {
      streamHits([HIT]);
    });
    renderPanel({ workspaceRootCount: 2 });
    expect(screen.getByText('Root A')).toBeInTheDocument();
  });

  it('gives the results tree the second, shrinkable grid row below the header', () => {
    act(() => {
      streamHits([HIT]);
    });
    const { container } = renderPanel();

    const grid = container.querySelector<HTMLElement>('.grid.h-full');
    expect(grid?.className).toContain('grid-rows-[auto_1fr]');
    const rows = Array.from(grid?.children ?? []);
    expect(rows).toHaveLength(2);
    const middle = rows[1] as HTMLElement;
    expect(middle.contains(screen.getByRole('treegrid'))).toBe(true);
    // The results row constrains height (min-h-0) so the 1fr track can shrink and the tree scrolls.
    expect(middle.className).toContain('min-h-0');
  });

  it('searches as the user types, once the typing pauses', () => {
    vi.useFakeTimers();
    try {
      const { props } = renderPanel();
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('fo');
        useWorkspaceSearchStore.getState().setQuery('foo');
        useWorkspaceSearchStore.getState().setQuery('foob');
      });
      expect(props.runSearch).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE);
      });
      expect(props.runSearch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not search a one-character query', () => {
    vi.useFakeTimers();
    try {
      const { props } = renderPanel();
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('f');
      });
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE);
      });
      expect(props.runSearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-runs the search when a match option changes', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('foo');
      });
      const { props } = renderPanel();
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_ADVANCE);
      });
      expect(props.runSearch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears results, and drops a late match, when the query shrinks below two characters', () => {
    act(() => {
      useWorkspaceSearchStore.getState().setQuery('foobar');
    });
    let staleGeneration = 0;
    act(() => {
      staleGeneration = streamHits([HIT]);
    });
    renderPanel();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();

    act(() => {
      useWorkspaceSearchStore.getState().setQuery('f');
    });
    act(() => {
      useWorkspaceSearchStore.getState().appendMatches([HIT], staleGeneration);
    });
    expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument();
    expect(useWorkspaceSearchStore.getState().status).toBe('idle');
  });
});
