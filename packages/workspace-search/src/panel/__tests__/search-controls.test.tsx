import { fireEvent, render, screen } from '@testing-library/react';
import { createContext, useContext } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import type { CollectionStatsRow } from '../collection-stats-query';
import { SearchCollectionPicker } from '../search-collection-picker';
import { SearchCoverageBanner } from '../search-coverage-banner';
import { SearchInputBar } from '../search-input-bar';
import { SearchModeToggle } from '../search-mode-toggle';

const { usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteLiveQueryMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

// The Radix-backed Select renders its content into a portal only while open,
// which makes it brittle to drive headlessly. Every other consumer in this
// repo (preferences, vector-management, app-shell) mocks the Select
// family the same way — keep Button/Input/Tooltip/Badge/cn real.
interface MockSelectContextValue {
  onValueChange: (value: string) => void;
}

const MockSelectContext = createContext<MockSelectContextValue | null>(null);

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
      value?: string;
    }) => (
      <MockSelectContext.Provider value={{ onValueChange: onValueChange ?? (() => undefined) }}>
        <div data-testid="mock-select">{children}</div>
      </MockSelectContext.Provider>
    ),
    SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children?: React.ReactNode; value: string }) => {
      const ctx = useContext(MockSelectContext);
      return (
        // biome-ignore lint/a11y/useKeyWithClickEvents: test double, not shipped UI
        <div onClick={() => ctx?.onValueChange(value)} role="option" tabIndex={0}>
          {children}
        </div>
      );
    },
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => (
      <div aria-expanded={false} role="combobox" tabIndex={0}>
        {children}
      </div>
    ),
    SelectValue: ({
      children,
      placeholder,
    }: {
      children?: React.ReactNode;
      placeholder?: string;
    }) => <span>{children ?? placeholder}</span>,
  };
});

function makeRow(overrides: Partial<CollectionStatsRow> = {}): CollectionStatsRow {
  return {
    chunkCount: 0,
    embeddedChunkCount: 0,
    fileCount: 0,
    id: 'workspace-index',
    name: 'Workspace Index',
    pendingChunkCount: 0,
    systemRole: 'workspace-index',
    ...overrides,
  };
}

function mockLiveQuery(byQuery: {
  files?: () => { rows: CollectionStatsRow[] };
  total?: () => { rows: Array<{ total: number }> };
}) {
  usePGliteLiveQueryMock.mockImplementation((options: { query: string }) => {
    if (options.query.includes('collection_indexing_stats')) {
      const result = byQuery.files?.() ?? { rows: [] };
      return { error: null, loading: false, refresh: vi.fn(), rows: result.rows };
    }
    const result = byQuery.total?.() ?? { rows: [{ total: 0 }] };
    return { error: null, loading: false, refresh: vi.fn(), rows: result.rows };
  });
}

describe('SearchInputBar', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    vi.clearAllMocks();
  });

  it('renders the three toggle buttons reflecting store state', () => {
    render(<SearchInputBar onSubmit={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Match whole word' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Use regular expression' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('clicking a toggle button flips the store flag and its aria-pressed state', () => {
    render(<SearchInputBar onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));

    expect(useWorkspaceSearchStore.getState().caseSensitive).toBe(true);
    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('typing in the input updates the store query', () => {
    render(<SearchInputBar onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Search workspace'), {
      target: { value: 'findMe' },
    });

    expect(useWorkspaceSearchStore.getState().query).toBe('findMe');
  });

  it('in text mode, Enter calls onSubmit', () => {
    const onSubmit = vi.fn();
    render(<SearchInputBar onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows the semantic-mode hint and Enter still calls onSubmit', () => {
    useWorkspaceSearchStore.getState().setMode('semantic');
    const onSubmit = vi.fn();
    render(<SearchInputBar onSubmit={onSubmit} />);

    expect(screen.getByText('Press Enter to search')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows a parser alert for an invalid regex and blocks Enter from submitting', () => {
    useWorkspaceSearchStore.getState().toggleRegex();
    const onSubmit = vi.fn();
    render(<SearchInputBar onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('Search workspace'), {
      target: { value: '(' },
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/./);

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a valid regex renders no alert and Enter calls onSubmit', () => {
    useWorkspaceSearchStore.getState().toggleRegex();
    const onSubmit = vi.fn();
    render(<SearchInputBar onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('Search workspace'), {
      target: { value: 'valid.*pattern' },
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('SearchModeToggle', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    vi.clearAllMocks();
    // SearchModeToggle now reads collection stats to gate the Semantic button;
    // seed embedded chunks so semantic stays enabled for these baseline tests.
    mockLiveQuery({ files: () => ({ rows: [makeRow({ embeddedChunkCount: 5 })] }) });
  });

  it('renders Text and Semantic buttons with Text active by default', () => {
    render(<SearchModeToggle />);

    expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Semantic' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('switching mode calls setMode and clears results', () => {
    useWorkspaceSearchStore.getState().resolveResults(
      {
        files: [],
        mode: 'text',
        notices: {
          candidatesTruncated: false,
          scanLimited: false,
          skippedMissingLineMetadata: 0,
          truncated: false,
        },
        totalMatches: 0,
      },
      useWorkspaceSearchStore.getState().generation
    );

    render(<SearchModeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Semantic' }));

    const state = useWorkspaceSearchStore.getState();
    expect(state.mode).toBe('semantic');
    expect(state.results).toBeNull();
    expect(state.status).toBe('idle');
  });
});

describe('SearchCollectionPicker', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    vi.clearAllMocks();
  });

  it('renders quiet text with no combobox when only the workspace index exists', () => {
    mockLiveQuery({ files: () => ({ rows: [makeRow()] }) });

    render(<SearchCollectionPicker />);

    expect(screen.getByText('Workspace Index')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('renders a select with a Managed badge on the workspace-index row when 2+ sets exist', () => {
    mockLiveQuery({
      files: () => ({
        rows: [makeRow(), makeRow({ id: 'user-set', name: 'User Collection', systemRole: null })],
      }),
    });

    render(<SearchCollectionPicker />);

    expect(screen.getByRole('combobox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(screen.getByText('Workspace Index')).toBeInTheDocument();
    expect(screen.getByText('User Collection')).toBeInTheDocument();
    expect(screen.getByText('Managed')).toBeInTheDocument();
  });

  it('choosing an option calls setCollectionId and onCollectionChange', () => {
    mockLiveQuery({
      files: () => ({
        rows: [makeRow(), makeRow({ id: 'user-set', name: 'User Collection', systemRole: null })],
      }),
    });
    const onCollectionChange = vi.fn();

    render(<SearchCollectionPicker onCollectionChange={onCollectionChange} />);
    fireEvent.click(screen.getByText('User Collection'));

    expect(useWorkspaceSearchStore.getState().collectionId).toBe('user-set');
    expect(onCollectionChange).toHaveBeenCalledWith('user-set');
  });
});

describe('SearchCoverageBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Indexing… with counts when chunks are pending', () => {
    mockLiveQuery({
      files: () => ({
        rows: [
          makeRow({
            chunkCount: 100,
            embeddedChunkCount: 40,
            fileCount: 10,
            pendingChunkCount: 60,
          }),
        ],
      }),
      total: () => ({ rows: [{ total: 10 }] }),
    });

    render(<SearchCoverageBanner collectionId={null} rootIds={['root-1']} />);

    expect(screen.getByText(/Indexing…/)).toBeInTheDocument();
    expect(screen.getByText(/40\/100/)).toBeInTheDocument();
  });

  it('renders nothing once the set covers every workspace file', () => {
    mockLiveQuery({
      files: () => ({
        rows: [
          makeRow({
            chunkCount: 100,
            embeddedChunkCount: 100,
            fileCount: 10,
            pendingChunkCount: 0,
          }),
        ],
      }),
      total: () => ({ rows: [{ total: 10 }] }),
    });

    const { container } = render(<SearchCoverageBanner collectionId={null} rootIds={['root-1']} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders "N of M files indexed" when partially covered', () => {
    mockLiveQuery({
      files: () => ({
        rows: [
          makeRow({
            chunkCount: 40,
            embeddedChunkCount: 40,
            fileCount: 4,
            pendingChunkCount: 0,
          }),
        ],
      }),
      total: () => ({ rows: [{ total: 10 }] }),
    });

    render(<SearchCoverageBanner collectionId={null} rootIds={['root-1']} />);

    expect(screen.getByText('4 of 10 files indexed')).toBeInTheDocument();
  });
});
