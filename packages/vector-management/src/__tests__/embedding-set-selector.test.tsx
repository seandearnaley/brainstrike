import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data
const mockCollections = [
  {
    category: null,
    createdAt: '2024-01-01T00:00:00Z',
    description: null,
    dimensions: 1536,
    distance: 'cosine' as const,
    fileCount: 10,
    id: 'set-1',
    modelId: 'text-embedding-3-small',
    modelKey: 'openai',
    name: 'Test Collection',
    tags: null,
  },
  {
    category: null,
    createdAt: '2024-01-02T00:00:00Z',
    description: null,
    dimensions: 3072,
    distance: 'cosine' as const,
    fileCount: 5,
    id: 'set-2',
    modelId: 'text-embedding-3-large',
    modelKey: 'openai',
    name: null,
    tags: null,
  },
];

const mockLiveQueryResult = {
  error: null,
  loading: false,
  refresh: vi.fn(),
  rows: mockCollections.map((c) => ({ ...c, fileCount: String(c.fileCount) })),
  rowsMatchQuery: true,
};

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteLiveQuery: vi.fn(() => mockLiveQueryResult),
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteLiveQuery: vi.fn(() => mockLiveQueryResult),
}));

// Mock preferences store for useEmbeddingSetSelection tests
const mockStoreState = {
  activeEmbeddingSetId: null as string | null,
  cachedCollections: [] as Array<{
    id: string;
    modelKey: string;
    modelId: string;
    dimensions: number;
    distance: 'cosine' | 'l2' | 'ip';
    createdAt: string;
    name: string | null;
    description: string | null;
    tags: string | null;
    category: string | null;
    fileCount: number;
    chunkCount: number;
    embeddingCount: number;
  }>,
  cachedFileData: null as null | {
    collectionCounts: {
      chunks: number;
      embeddings: number;
      records: number;
    };
    collectionId: string;
    page: number;
    pageSize: number;
    records: Array<{
      id: string;
      name: string;
      path: string;
      size: number;
      createdAt: string;
      updatedAt: string;
      tokenCount: number | undefined;
      chunksCount: number | undefined;
      embeddingSetId: string | undefined;
    }>;
    chunks: Array<{
      id: string;
      fileRecordId: string;
      chunkIndex: number;
      tokenCount: number;
      chunkType: 'text' | 'sentence' | 'recursive' | 'code';
      embeddingSetId: string | undefined;
    }>;
    totalRecords: number;
  },
  isEmbeddingActive: false,
  isEmbeddingQueueActive: false,
  isImporting: false,
  isJobQueueActive: false,
  schemaVerified: true,
  setActiveEmbeddingSetId: vi.fn(),
  setCachedCollections: vi.fn(),
  setCachedFileData: vi.fn(),
  setIsEmbeddingQueueActive: vi.fn(),
  setIsImporting: vi.fn(),
  setIsJobQueueActive: vi.fn(),
  setSchemaVerified: vi.fn(),
};

vi.mock('@brainstrike/app-state/stores/vector-status-ui-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/app-state/stores/vector-status-ui-store')>();
  return {
    ...actual,
    useVectorStatusUIStore: vi.fn((selector: (state: typeof mockStoreState) => unknown) =>
      selector(mockStoreState)
    ),
  };
});

// Use a valid HTML structure for select mock - no nested divs inside select
vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    Select: ({ children, onValueChange, value, disabled }: any) => {
      // Separate the children into trigger/content vs options
      return (
        <div data-disabled={disabled} data-testid="select" data-value={value}>
          <select
            aria-label="Select collection"
            data-testid="select-native"
            disabled={disabled}
            onChange={(e) => onValueChange?.(e.target.value)}
            value={value}
          >
            <option value="">Select...</option>
            {/* Options will be rendered separately */}
          </select>
          {/* Render non-option children outside the select */}
          <div data-testid="select-ui">{children}</div>
        </div>
      );
    },
    SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
    SelectItem: ({ children, value, className }: any) => (
      <div className={className} data-testid={`select-item-${value}`} data-value={value}>
        {children}
      </div>
    ),
    SelectTrigger: ({ children, className }: any) => (
      <div className={className} data-testid="select-trigger">
        {children}
      </div>
    ),
    SelectValue: ({ placeholder, children }: any) => (
      <span data-testid="select-value">{children || placeholder}</span>
    ),
  };
});

import { usePGliteLiveQuery } from '@brainstrike/db/react';
import {
  EmbeddingSetSelector,
  useEmbeddingSetSelection,
} from '../vector-status/embedding-set-selector';

describe('EmbeddingSetSelector', () => {
  const mockDb = {} as any;
  const mockOnSelectionChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePGliteLiveQuery).mockReturnValue(mockLiveQueryResult);
    mockStoreState.activeEmbeddingSetId = null;
    mockStoreState.cachedCollections = [];
    mockStoreState.schemaVerified = true;
    mockStoreState.isEmbeddingActive = false;
    mockStoreState.isImporting = false;
  });

  it('renders with collections', () => {
    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId={null}
      />
    );

    expect(screen.getByTestId('select')).toBeInTheDocument();
    expect(screen.getByText('Select collection...')).toBeInTheDocument();
  });

  it('renders with loading state when db is not available', () => {
    vi.mocked(usePGliteLiveQuery).mockReturnValue({
      ...mockLiveQueryResult,
      loading: true,
      rowsMatchQuery: false,
    });

    render(
      <EmbeddingSetSelector
        db={null as any}
        onSelectionChange={mockOnSelectionChange}
        selectedId={null}
      />
    );

    expect(screen.getByTestId('select')).toHaveAttribute('data-disabled', 'true');
  });

  it('displays selected collection with file count', () => {
    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId="set-1"
      />
    );

    // Check the select-value specifically to avoid matching the option
    const selectValue = screen.getByTestId('select-value');
    expect(selectValue).toHaveTextContent('Test Collection (10 files)');
  });

  it('displays model ID when name is null', () => {
    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId="set-2"
      />
    );

    // Check the select-value specifically to avoid matching the option
    const selectValue = screen.getByTestId('select-value');
    expect(selectValue).toHaveTextContent('text-embedding-3-large (5 files)');
  });

  it('calls onSelectionChange when selection changes', async () => {
    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId={null}
      />
    );

    const select = screen.getByTestId('select-native');
    // Simulate change event directly since mock doesn't have real options
    select.dispatchEvent(new Event('change', { bubbles: true }));
    // Manually set and trigger the change
    (select as HTMLSelectElement).value = 'set-1';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // The mock select calls onValueChange with the selected value
    expect(mockOnSelectionChange).toHaveBeenCalled();
  });

  it('shows empty state when no collections exist', () => {
    vi.mocked(usePGliteLiveQuery).mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [],
      rowsMatchQuery: true,
    });

    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId={null}
      />
    );

    expect(screen.getByText('No embedding sets yet')).toBeInTheDocument();
  });

  it('uses compact size styling', () => {
    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId={null}
      />
    );

    const trigger = screen.getByTestId('select-trigger');
    expect(trigger).toHaveClass('h-7');
  });

  it('formats file count with singular form', () => {
    vi.mocked(usePGliteLiveQuery).mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [
        {
          ...mockCollections[0],
          fileCount: '1',
        },
      ],
      rowsMatchQuery: true,
    });

    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId="set-1"
      />
    );

    const selectValue = screen.getByTestId('select-value');
    expect(selectValue).toHaveTextContent('Test Collection (1 file)');
  });

  it('formats large file counts with locale separator', () => {
    vi.mocked(usePGliteLiveQuery).mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [
        {
          ...mockCollections[0],
          fileCount: '1234567',
        },
      ],
      rowsMatchQuery: true,
    });

    render(
      <EmbeddingSetSelector
        db={mockDb}
        onSelectionChange={mockOnSelectionChange}
        selectedId="set-1"
      />
    );

    // Check for formatted number (locale-dependent)
    const selectValue = screen.getByTestId('select-value');
    expect(selectValue).toHaveTextContent('1,234,567 files');
  });
});

describe('useEmbeddingSetSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.activeEmbeddingSetId = null;
  });

  it('returns selectedId from store', () => {
    mockStoreState.activeEmbeddingSetId = 'test-set-id';

    const { result } = renderHook(() => useEmbeddingSetSelection());

    expect(result.current.selectedId).toBe('test-set-id');
  });

  it('returns null when no selection', () => {
    mockStoreState.activeEmbeddingSetId = null;

    const { result } = renderHook(() => useEmbeddingSetSelection());

    expect(result.current.selectedId).toBeNull();
  });

  it('calls setActiveEmbeddingSetId when setSelectedId is called', () => {
    const { result } = renderHook(() => useEmbeddingSetSelection());

    act(() => {
      result.current.setSelectedId('new-set-id');
    });

    expect(mockStoreState.setActiveEmbeddingSetId).toHaveBeenCalledWith('new-set-id');
  });

  it('calls setActiveEmbeddingSetId with null to clear selection', () => {
    mockStoreState.activeEmbeddingSetId = 'existing-id';
    const { result } = renderHook(() => useEmbeddingSetSelection());

    act(() => {
      result.current.setSelectedId(null);
    });

    expect(mockStoreState.setActiveEmbeddingSetId).toHaveBeenCalledWith(null);
  });

  it('memoizes setSelectedId callback', () => {
    const { result, rerender } = renderHook(() => useEmbeddingSetSelection());
    const firstCallback = result.current.setSelectedId;

    rerender();

    expect(result.current.setSelectedId).toBe(firstCallback);
  });
});
