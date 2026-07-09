import { act, fireEvent, render, screen } from '@testing-library/react';
import { createContext } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverageState } from '../../bridge/range-math';
import type { SearchSelectionBridge } from '../../bridge/use-search-selection-bridge';
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
  chunkState: vi.fn((): CoverageState => 'unchecked'),
  isFileChecked: vi.fn(() => false),
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

import { WorkspaceSearchPanel } from '../workspace-search-panel';

function makeResults(): WorkspaceSearchResults {
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
      useWorkspaceSearchStore.getState().resolveResults(makeResults());
    });
    renderPanel();
    expect(screen.getByRole('treegrid')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
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
    expect(screen.getByText('~0 tokens selected')).toBeInTheDocument();
  });
});

const TEXT_DEBOUNCE_ADVANCE = 300;
