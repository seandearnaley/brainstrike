import { act, fireEvent, render, screen } from '@testing-library/react';
import { createContext } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChunkSelectionState,
  FileSelectionState,
  SearchSelectionBridge,
} from '../../bridge/use-search-selection-bridge';
import type { WorkspaceSearchResults } from '../../core/search-result-model';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';

const { usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteLiveQueryMock: vi.fn(() => ({ rows: [] })),
}));

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

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

const MockSelectContext = createContext<{ onValueChange: (v: string) => void } | null>(null);
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    Select: ({
      children,
      onValueChange,
    }: {
      children?: React.ReactNode;
      onValueChange?: (value: string) => void;
    }) => (
      <MockSelectContext.Provider value={{ onValueChange: onValueChange ?? (() => undefined) }}>
        <div>{children}</div>
      </MockSelectContext.Provider>
    ),
    SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    SelectValue: () => null,
  };
});

import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import { WorkspaceSearchPanel } from '../workspace-search-panel';

function makeResults(overrides?: Partial<WorkspaceSearchResults>): WorkspaceSearchResults {
  return {
    files: [
      {
        children: [
          {
            after: [],
            before: [],
            chunkEndLine: 12,
            chunkId: 'chunk-1',
            chunkStartLine: 8,
            kind: 'match',
            line: 10,
            lineText: 'const foo = 1;',
            provenance: 'index',
          },
        ],
        dbRootId: 'root-a',
        path: 'src/a.ts',
        rootDisplayName: 'Root A',
      },
    ],
    mode: 'text',
    notices: {
      candidatesTruncated: false,
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      truncated: false,
    },
    totalMatches: 1,
    ...overrides,
  };
}

const resolveAdapterRootId = (dbRootId: string): string | null => `adapter-${dbRootId}`;

function renderPanel(overrides: Partial<React.ComponentProps<typeof WorkspaceSearchPanel>> = {}) {
  const props = {
    onOpenFile: vi.fn(),
    resolveAdapterRootId,
    runSemanticSearch: vi.fn(),
    runTextSearch: vi.fn(),
    workspaceDbRootIds: ['root-a'],
    ...overrides,
  };
  return { ...render(<WorkspaceSearchPanel {...props} />), props };
}

describe('WorkspaceSearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceSearchStore.getState().reset();
    useWorkspaceContextCurationStore.setState({ contextSnapshot: null });
  });

  it('shows the idle empty state before any search', () => {
    renderPanel();
    expect(screen.getByText('Search your workspace by text or meaning.')).toBeInTheDocument();
  });

  it('shows a searching indicator', () => {
    act(() => {
      useWorkspaceSearchStore.setState({ status: 'searching' });
    });
    renderPanel();
    expect(screen.getByText('Searching…')).toBeInTheDocument();
  });

  it('shows the error card with the message and re-runs on Retry', () => {
    act(() => {
      useWorkspaceSearchStore.setState({ error: 'Boom', status: 'error' });
    });
    const { props } = renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.runTextSearch).toHaveBeenCalledTimes(1);
  });

  it('renders the results tree when the search resolves', () => {
    act(() => {
      const generation = useWorkspaceSearchStore.getState().generation;
      useWorkspaceSearchStore.getState().resolveResults(makeResults(), generation);
    });
    renderPanel();
    expect(screen.getByRole('treegrid')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('threads the mounted-root count so single-root results still show root badges in a multi-root workspace', () => {
    act(() => {
      const generation = useWorkspaceSearchStore.getState().generation;
      useWorkspaceSearchStore.getState().resolveResults(makeResults(), generation);
    });
    renderPanel({ workspaceDbRootIds: ['root-a', 'root-b'] });
    // Results all come from root-a, but the workspace mounts two roots — the
    // badge must attribute the results to their root.
    expect(screen.getByText('Root A')).toBeInTheDocument();
  });

  it('pins the footer via a three-row grid with the results tree in the middle scroll region', () => {
    act(() => {
      const generation = useWorkspaceSearchStore.getState().generation;
      useWorkspaceSearchStore.getState().resolveResults(makeResults(), generation);
    });
    const { container } = renderPanel();

    // The panel is a full-height three-row grid: header / results / footer.
    const grid = container.querySelector<HTMLElement>('.grid.h-full');
    expect(grid).not.toBeNull();
    expect(grid?.className).toContain('grid-rows-[auto_1fr_auto]');
    const rows = Array.from(grid?.children ?? []);
    expect(rows).toHaveLength(3);

    // The footer is the LAST grid row (pinned to the bottom), not flowing after
    // the tree content, and carries the top border like the Explorer footer.
    const footer = rows.at(-1) as HTMLElement;
    expect(footer.tagName).toBe('FOOTER');
    expect(footer.className).toContain('border-t');
    expect(footer).toHaveTextContent('~0 tokens in context');

    // The results tree lives in the middle (1fr) row's scroll region, never
    // inside the footer.
    const middle = rows[1] as HTMLElement;
    const treegrid = screen.getByRole('treegrid');
    expect(middle.contains(treegrid)).toBe(true);
    expect(footer.contains(treegrid)).toBe(false);
    // The middle row constrains height (min-h-0) so the 1fr track can shrink and
    // the tree scrolls rather than pushing the footer away.
    expect(middle.className).toContain('min-h-0');
  });

  it('debounces text-mode queries and calls runTextSearch after 250ms', () => {
    vi.useFakeTimers();
    try {
      const { props } = renderPanel();
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('foobar');
      });
      expect(props.runTextSearch).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(TEXT_DEBOUNCE_ADVANCE);
      });
      expect(props.runTextSearch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-run in text mode for queries shorter than 3 chars', () => {
    vi.useFakeTimers();
    try {
      const { props } = renderPanel();
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('fo');
      });
      act(() => {
        vi.advanceTimersByTime(TEXT_DEBOUNCE_ADVANCE);
      });
      expect(props.runTextSearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-run in semantic mode', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        useWorkspaceSearchStore.setState({ mode: 'semantic' });
      });
      const { props } = renderPanel();
      act(() => {
        useWorkspaceSearchStore.getState().setQuery('foobar');
      });
      act(() => {
        vi.advanceTimersByTime(TEXT_DEBOUNCE_ADVANCE);
      });
      expect(props.runTextSearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows selected token count in the footer', () => {
    renderPanel();
    expect(screen.getByText('~0 tokens in context')).toBeInTheDocument();
  });

  it('reports OUTPUT (post-range) tokens in the footer, not source tokens', () => {
    // The per-file range model means checking one chunk of a huge file must show
    // the small output number, never the full source total.
    act(() => {
      useWorkspaceContextCurationStore.getState().setContextSnapshot({
        files: [],
        includeProjectTree: false,
        projectTreeApproxTokens: null,
        projectTreeTokenCountLoading: false,
        selectedOutputApproxTokens: 12,
        selectedSourceApproxTokens: 9999,
        selectionFolderId: null,
        tokenBudget: null,
      });
    });
    renderPanel();
    expect(screen.getByText('~12 tokens in context')).toBeInTheDocument();
    expect(screen.queryByText('~9999 tokens in context')).not.toBeInTheDocument();
  });

  it('clears stale results and drops a late resolve when the text query shrinks below min length', () => {
    // A previous longer query produced results.
    act(() => {
      useWorkspaceSearchStore.getState().setQuery('foobar');
      const generation = useWorkspaceSearchStore.getState().generation;
      useWorkspaceSearchStore.getState().resolveResults(makeResults(), generation);
    });
    const staleGeneration = useWorkspaceSearchStore.getState().generation;
    renderPanel();
    expect(useWorkspaceSearchStore.getState().results).not.toBeNull();

    // Shrink the query below the 3-char threshold.
    act(() => {
      useWorkspaceSearchStore.getState().setQuery('fo');
    });
    expect(useWorkspaceSearchStore.getState().results).toBeNull();
    expect(useWorkspaceSearchStore.getState().status).toBe('idle');

    // The in-flight longer-query run resolving late (with the pre-clear
    // generation) must be dropped, not resurrect the cleared results.
    act(() => {
      useWorkspaceSearchStore.getState().resolveResults(makeResults(), staleGeneration);
    });
    expect(useWorkspaceSearchStore.getState().results).toBeNull();
    expect(useWorkspaceSearchStore.getState().status).toBe('idle');
  });

  it('Show more bumps the text result limit by 200 and reruns the text search', () => {
    const truncatedResults = makeResults({
      notices: {
        candidatesTruncated: false,
        scanLimited: false,
        skippedMissingLineMetadata: 0,
        truncated: true,
      },
    });
    act(() => {
      const generation = useWorkspaceSearchStore.getState().generation;
      useWorkspaceSearchStore.getState().resolveResults(truncatedResults, generation);
    });
    const before = useWorkspaceSearchStore.getState().textResultLimit;
    const { props } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

    expect(useWorkspaceSearchStore.getState().textResultLimit).toBe(before + 200);
    expect(props.runTextSearch).toHaveBeenCalledTimes(1);
  });

  it('does not offer Show more in semantic mode (no semantic paging)', () => {
    const truncatedSemanticResults = makeResults({
      mode: 'semantic',
      notices: {
        candidatesTruncated: false,
        scanLimited: false,
        skippedMissingLineMetadata: 0,
        truncated: true,
      },
    });
    act(() => {
      useWorkspaceSearchStore.setState({ mode: 'semantic' });
      const generation = useWorkspaceSearchStore.getState().generation;
      useWorkspaceSearchStore.getState().resolveResults(truncatedSemanticResults, generation);
    });
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});

const TEXT_DEBOUNCE_ADVANCE = 300;
