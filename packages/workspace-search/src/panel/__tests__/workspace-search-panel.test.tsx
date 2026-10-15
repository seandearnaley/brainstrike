import { act, fireEvent, render, screen } from '@testing-library/react';
import { createContext } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileSelectionState,
  SearchSelectionBridge,
} from '../../bridge/use-search-selection-bridge';
import type { WorkspaceSearchResults } from '../../core/search-result-model';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';

const { usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteLiveQueryMock: vi.fn((): { rows: unknown[] } => ({ rows: [] })),
}));

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));
vi.mock('@brainstrike/db/react', () => ({
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
  fileState: vi.fn((): FileSelectionState => 'unchecked'),
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

import { SEMANTIC_UNAVAILABLE_NO_CHUNKS } from '../use-semantic-availability';
import { WorkspaceSearchPanel } from '../workspace-search-panel';

/** Workspace-index stats row used to drive `useSemanticAvailability` per-test. */
function workspaceIndexRow(embeddedChunkCount: number | null) {
  return {
    chunkCount: 0,
    embeddedChunkCount,
    fileCount: 0,
    id: 'workspace-index',
    name: 'Workspace Index',
    pendingChunkCount: 0,
    systemRole: 'workspace-index' as const,
  };
}

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

  it('gives the results tree the second, shrinkable grid row below the header', () => {
    act(() => {
      const generation = useWorkspaceSearchStore.getState().generation;
      useWorkspaceSearchStore.getState().resolveResults(makeResults(), generation);
    });
    const { container } = renderPanel();

    // A full-height two-row grid: header / results. The retired "tokens in
    // context" footer read the checked-files snapshot (BST-2019).
    const grid = container.querySelector<HTMLElement>('.grid.h-full');
    expect(grid).not.toBeNull();
    expect(grid?.className).toContain('grid-rows-[auto_1fr]');
    const rows = Array.from(grid?.children ?? []);
    expect(rows).toHaveLength(2);
    expect(container.querySelector('footer')).toBeNull();

    const middle = rows[1] as HTMLElement;
    const treegrid = screen.getByRole('treegrid');
    expect(middle.contains(treegrid)).toBe(true);
    // The results row constrains height (min-h-0) so the 1fr track can shrink and
    // the tree scrolls.
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

  it('gated semantic submit surfaces the reason and never runs the (lexical-degradable) hybrid search', () => {
    // Regression (PR #1757 review, Codex P1): the semantic executor's hybrid
    // search has an FTS arm scoped only by embedding_set_id (no `embedding IS
    // NOT NULL`), so a pressed-Semantic Enter against a zero-embedding set would
    // silently return lexical-only results. The submit must be gated like the
    // toggle: fail VISIBLY (error card) while preserving the user's mode.
    usePGliteLiveQueryMock.mockReturnValue({ rows: [workspaceIndexRow(0)] });
    act(() => {
      useWorkspaceSearchStore.setState({ mode: 'semantic', query: 'foobar' });
    });
    const { props } = renderPanel();

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(props.runSemanticSearch).not.toHaveBeenCalled();
    const state = useWorkspaceSearchStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe(SEMANTIC_UNAVAILABLE_NO_CHUNKS);
    expect(state.mode).toBe('semantic');
    expect(screen.getByRole('alert')).toHaveTextContent(SEMANTIC_UNAVAILABLE_NO_CHUNKS);
  });

  it('available semantic submit runs the semantic search', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [workspaceIndexRow(42)] });
    act(() => {
      useWorkspaceSearchStore.setState({ mode: 'semantic', query: 'foobar' });
    });
    const { props } = renderPanel();

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(props.runSemanticSearch).toHaveBeenCalledTimes(1);
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
