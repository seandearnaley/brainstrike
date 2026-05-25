import type { FileChunk, FileRecord } from '@brainstrike/db';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCollectionBrowserStoreForTests,
  useCollectionBrowserStore,
} from '../../stores/collection-browser-store';
import type { DatabaseFileChunkSummary } from '../../use-database-demo-data';
import { CollectionBrowserView } from '../collection-browser-view';

const collectionBrowserPropsSpy = vi.fn<(props: Record<string, unknown>) => void>();
const semanticSearchMock = vi.hoisted(() => ({
  clearResults: vi.fn(),
  executeSearch: vi.fn(),
  state: {
    error: null as string | null,
    hasSearched: false,
    isSearching: false,
    searchResults: [] as Array<{
      chunkId: string;
      content: string;
      chunkIndex?: number;
      embeddingDimensions?: number;
      embeddingSetId: string;
      fileName: string;
      filePath: string;
      fileSize?: number;
      fileRecordId: string;
      tokenCount?: number;
    }>,
  },
}));

vi.mock('../../contexts/semantic-search-context', () => ({
  useSemanticSearch: () => ({
    ...semanticSearchMock.state,
    executeSearch: semanticSearchMock.executeSearch,
    clearResults: semanticSearchMock.clearResults,
  }),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();

  const Button = ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  );

  const CollectionBrowser = (props: {
    data: { files: Array<{ id: string }> };
    emptyMessage?: string;
    hasSearched?: boolean;
    onSelect?: (nodeId: string, nodeType: string, nodeData: unknown) => void;
    onSelectedIdChange?: (id: string | null) => void;
    multiSelectEnabled?: boolean;
    onDoubleClick?: (nodeId: string, nodeType: string, nodeData: unknown) => void;
    onContextMenu?: (
      nodeId: string,
      nodeType: string,
      nodeData: unknown,
      event: MouseEvent
    ) => void;
    bulkActions?: Array<{ id: string; label: string }>;
    onMultiSelect?: (ids: Set<string>) => void;
    semanticResults?: unknown[];
    showCheckbox?: boolean;
    treeWindowingStrategy?: string;
  }) => {
    collectionBrowserPropsSpy(props as Record<string, unknown>);
    const {
      data,
      emptyMessage,
      onSelect,
      onSelectedIdChange,
      multiSelectEnabled,
      onDoubleClick,
      onContextMenu,
      bulkActions,
      onMultiSelect,
      showCheckbox,
    } = props;
    const firstFile = data.files[0];

    return (
      <div data-testid="collection-browser">
        {multiSelectEnabled && <span data-testid="multi-select-enabled" />}
        {showCheckbox && <span data-testid="show-checkbox" />}
        {bulkActions && bulkActions.length > 0 && (
          <span data-testid="bulk-actions-count">{bulkActions.length}</span>
        )}
        {!firstFile && emptyMessage ? (
          <span data-testid="empty-message">{emptyMessage}</span>
        ) : null}
        {firstFile ? (
          <>
            <button
              aria-label="Select first file"
              onClick={() => onSelect?.(`file-${firstFile.id}`, 'file', {})}
              type="button"
            >
              Select first file
            </button>
            <button
              aria-label="Double-click first file"
              onClick={() => onDoubleClick?.(`file-${firstFile.id}`, 'file', {})}
              type="button"
            >
              Double-click file
            </button>
            <button
              aria-label="Right-click first file"
              onClick={(e) =>
                onContextMenu?.(`file-${firstFile.id}`, 'file', {}, e as unknown as MouseEvent)
              }
              type="button"
            >
              Right-click file
            </button>
            <button
              aria-label="Multi-select"
              onClick={() => onMultiSelect?.(new Set([`file-${firstFile.id}`]))}
              type="button"
            >
              Multi-select
            </button>
          </>
        ) : null}
        <button
          aria-label="Clear selection"
          onClick={() => onSelectedIdChange?.(null)}
          type="button"
        >
          Clear selection
        </button>
      </div>
    );
  };

  const NodeInspector = ({ nodeId, nodeType }: { nodeId?: string; nodeType: string | null }) => (
    <div data-testid="node-inspector">{`${nodeType ?? 'none'}:${nodeId ?? ''}`}</div>
  );
  const TablePagination = ({
    currentPage,
    pageSize,
    totalItems,
    totalPages,
  }: {
    currentPage: number;
    pageSize?: number;
    totalItems: number;
    totalPages: number;
  }) => (
    <div data-testid="table-pagination">{`${currentPage}:${pageSize ?? 0}:${totalItems}:${totalPages}`}</div>
  );

  const SearchModeBar = ({
    advancedOptions,
    isSearchExpanded,
    onSemanticSearch,
    onSearchExpandedChange,
  }: {
    advancedOptions?: ReactNode;
    isSearchExpanded?: boolean;
    onSemanticSearch?: () => void;
    onSearchExpandedChange?: (expanded: boolean) => void;
  }) => (
    <div data-testid="search-mode-bar">
      <button
        aria-expanded={isSearchExpanded ? 'true' : 'false'}
        aria-label="Hybrid search"
        onClick={() => onSearchExpandedChange?.(!isSearchExpanded)}
        type="button"
      >
        Hybrid search
      </button>
      <button aria-label="Run hybrid search" onClick={onSemanticSearch} type="button">
        Run hybrid search
      </button>
      {isSearchExpanded && advancedOptions}
    </div>
  );

  const CollectionBrowserToolbar = ({
    multiSelectEnabled,
    onMultiSelectToggle,
    groupBy,
    onGroupByChange,
    onExpandAll,
  }: {
    multiSelectEnabled?: boolean;
    onMultiSelectToggle?: (enabled: boolean) => void;
    groupBy?: string;
    onGroupByChange?: (key: string) => void;
    onExpandAll?: () => void;
  }) => (
    <div data-testid="collection-browser-toolbar">
      {onMultiSelectToggle && (
        <button
          aria-label="Toggle multi-select"
          onClick={() => onMultiSelectToggle(!multiSelectEnabled)}
          type="button"
        >
          Toggle multi-select
        </button>
      )}
      {onGroupByChange && (
        <button
          aria-label="Group by status"
          onClick={() => onGroupByChange('status')}
          type="button"
        >
          Group by status
        </button>
      )}
      {onExpandAll && (
        <button aria-label="Expand all" onClick={onExpandAll} type="button">
          Expand all
        </button>
      )}
      {groupBy && groupBy !== 'none' && <span data-testid="active-group-by">{groupBy}</span>}
    </div>
  );
  const SearchConfigPanel = () => <div data-testid="search-config-panel" />;
  const FilterBar = () => <div data-testid="filter-bar" />;

  // DropdownMenu mocks for context menu
  const DropdownMenu = ({
    children,
    open,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (open ? <div data-testid="context-menu">{children}</div> : null);
  const DropdownMenuTrigger = ({ children }: { children: ReactNode }) => <>{children}</>;
  const DropdownMenuContent = ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  );
  const DropdownMenuItem = ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  );
  const DropdownMenuSeparator = () => <hr />;

  return {
    ...actual,
    Button,
    CollectionBrowser,
    CollectionBrowserToolbar,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    FilterBar,
    NodeInspector,
    SearchConfigPanel,
    SearchModeBar,
    TablePagination,
  };
});

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: ReactNode }) => <div data-testid="panel-group">{children}</div>,
  Panel: ({ children, id }: { children: ReactNode; id?: string }) => (
    <div data-testid={id ? `panel-${id}` : 'panel-main'}>{children}</div>
  ),
  Separator: () => <div data-testid="resize-handle" />,
}));

const TEST_RECORDS: FileRecord[] = [
  {
    id: '1',
    name: 'one.ts',
    path: '/one.ts',
    size: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const TEST_CHUNKS: FileChunk[] = [
  {
    id: 'chunk-1',
    fileRecordId: '1',
    chunkIndex: 0,
    content: 'const one = 1;',
    contentHash: 'chunk-hash',
    tokenCount: 4,
    chunkType: 'code',
    chunkSize: 16,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('CollectionBrowserView', () => {
  beforeEach(() => {
    __resetCollectionBrowserStoreForTests();
    vi.clearAllMocks();
    semanticSearchMock.state = {
      error: null,
      hasSearched: false,
      isSearching: false,
      searchResults: [],
    };
    collectionBrowserPropsSpy.mockClear();
  });

  it('renders inspector panel only while an inspectable node is selected', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    expect(screen.queryByTestId('panel-inspector-panel')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Select first file' }));

    expect(screen.getByTestId('panel-inspector-panel')).toBeInTheDocument();
    expect(screen.getByTestId('node-inspector')).toHaveTextContent('file:1');

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));

    expect(screen.queryByTestId('panel-inspector-panel')).not.toBeInTheDocument();
  });

  it('does not render the collapsed inspector handle without inspectable selection', () => {
    useCollectionBrowserStore.getState().setSelectedId('collection-collection-a');
    useCollectionBrowserStore.getState().setInspectorCollapsed(true);

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[]}
        height={500}
        records={TEST_RECORDS}
      />
    );

    expect(screen.queryByRole('button', { name: /show inspector panel/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-inspector-panel')).not.toBeInTheDocument();
  });

  it('passes multiSelectEnabled to CollectionBrowser when toggled', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    // Multi-select is off by default
    expect(screen.queryByTestId('multi-select-enabled')).not.toBeInTheDocument();

    // Toggle multi-select via the SearchModeBar toggle button
    await user.click(screen.getByRole('button', { name: 'Toggle multi-select' }));

    // Store should be updated
    expect(useCollectionBrowserStore.getState().multiSelectEnabled).toBe(true);
    expect(useCollectionBrowserStore.getState().showCheckbox).toBe(true);

    // CollectionBrowser should now receive multiSelectEnabled
    expect(screen.getByTestId('multi-select-enabled')).toBeInTheDocument();
  });

  it('passes bulk actions to CollectionBrowser', () => {
    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    // 3 bulk actions: Expand, Collapse, Copy IDs
    expect(screen.getByTestId('bulk-actions-count')).toHaveTextContent('3');
  });

  it('nests advanced options inside the expanded hybrid search panel', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    expect(screen.queryByTestId('search-config-panel')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hybrid search' }));

    expect(screen.getByTestId('search-mode-bar')).toContainElement(
      screen.getByTestId('search-config-panel')
    );
  });

  it('renders collection grid controls in their own toolbar', () => {
    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    expect(screen.getByTestId('collection-browser-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('search-mode-bar')).not.toContainElement(
      screen.getByTestId('collection-browser-toolbar')
    );
  });

  it('prioritizes the no-collection empty state over stale semantic search state', () => {
    semanticSearchMock.state = {
      error: null,
      hasSearched: true,
      isSearching: false,
      searchResults: [
        {
          chunkId: 'stale-chunk',
          content: 'stale semantic result',
          embeddingSetId: 'collection-a',
          fileName: 'stale.ts',
          filePath: '/stale.ts',
          fileRecordId: 'stale-file',
        },
      ],
    };
    useCollectionBrowserStore.getState().setSearchMode('semantic');

    render(
      <CollectionBrowserView activeCollectionId={null} chunks={[]} height={500} records={[]} />
    );

    expect(screen.getByTestId('empty-message')).toHaveTextContent(
      'Create or select a collection to start importing files and searching with semantic embeddings.'
    );
    expect(screen.queryByText(/No matching results found/i)).not.toBeInTheDocument();

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestProps).toMatchObject({
      data: { files: [] },
      hasSearched: false,
    });
    expect(latestProps).not.toHaveProperty('semanticResults');
  });

  it('does not execute hybrid search without an active collection', async () => {
    const user = userEvent.setup();
    useCollectionBrowserStore.getState().setSemanticQuery('orphan query');

    render(
      <CollectionBrowserView activeCollectionId={null} chunks={[]} height={500} records={[]} />
    );

    await user.click(screen.getByRole('button', { name: 'Run hybrid search' }));

    expect(semanticSearchMock.executeSearch).not.toHaveBeenCalled();
  });

  it('filters stale semantic results from a previously active collection', () => {
    semanticSearchMock.state = {
      error: null,
      hasSearched: true,
      isSearching: false,
      searchResults: [
        {
          chunkId: 'stale-chunk',
          content: 'stale semantic result',
          embeddingSetId: 'collection-a',
          fileName: 'stale.ts',
          filePath: '/stale.ts',
          fileRecordId: 'stale-file',
        },
      ],
    };
    useCollectionBrowserStore.getState().setSearchMode('semantic');

    render(
      <CollectionBrowserView
        activeCollectionId="collection-b"
        chunks={[]}
        height={500}
        records={[]}
      />
    );

    expect(screen.getByTestId('empty-message')).toHaveTextContent(
      'No matching results found. Try adjusting your query or threshold.'
    );

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestProps).toMatchObject({
      data: { files: [] },
      hasSearched: true,
      semanticResults: [],
    });
  });

  it('preserves semantic result metadata for file sizes, chunk tokens, and embedding rows', () => {
    semanticSearchMock.state = {
      error: null,
      hasSearched: true,
      isSearching: false,
      searchResults: [
        {
          chunkId: 'result-chunk',
          chunkIndex: 7,
          content: 'matched chunk body',
          embeddingDimensions: 1536,
          embeddingSetId: 'collection-1',
          fileName: 'result.ts',
          filePath: '/src/result.ts',
          fileRecordId: 'result-file',
          fileSize: 4096,
          tokenCount: 128,
        },
      ],
    };
    useCollectionBrowserStore.getState().setSearchMode('semantic');

    render(
      <CollectionBrowserView
        activeCollectionId="collection-1"
        chunks={[]}
        height={500}
        records={[]}
      />
    );

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestProps).toMatchObject({
      data: {
        files: [
          expect.objectContaining({
            id: 'result-file',
            size: 4096,
          }),
        ],
        chunks: [
          expect.objectContaining({
            id: 'result-chunk',
            chunkIndex: 7,
            tokenCount: 128,
            embeddingDimensions: 1536,
            hasEmbedding: true,
          }),
        ],
      },
    });
  });

  it('renders source pagination controls without double-paging the tree', () => {
    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        pagination={{
          currentPage: 1,
          onPageChange: vi.fn(),
          onPageSizeChange: vi.fn(),
          pageSize: 50,
          totalRecords: 120,
        }}
        records={TEST_RECORDS}
      />
    );

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestProps).toMatchObject({
      treeWindowingStrategy: 'virtual',
    });
    expect(screen.getByTestId('table-pagination')).toHaveTextContent('1:50:120:3');
  });

  it('renders source pagination without an extra padded wrapper', () => {
    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        pagination={{
          currentPage: 1,
          onPageChange: vi.fn(),
          onPageSizeChange: vi.fn(),
          pageSize: 50,
          totalRecords: 120,
        }}
        records={TEST_RECORDS}
      />
    );

    const paginationElement = screen.getByTestId('table-pagination');
    expect(paginationElement.parentElement).not.toHaveClass('px-3');
    expect(paginationElement.parentElement).not.toHaveClass('py-2');
    expect(paginationElement.parentElement).not.toHaveClass('border-t');
  });

  it('handles double-click by toggling expansion for file nodes', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    // Double-click a file node → should toggle its expanded state
    await user.click(screen.getByRole('button', { name: 'Double-click first file' }));

    // file-1 should now be in expandedIds
    expect(useCollectionBrowserStore.getState().expandedIds).toContain('file-1');

    // Double-click again → should collapse
    await user.click(screen.getByRole('button', { name: 'Double-click first file' }));
    expect(useCollectionBrowserStore.getState().expandedIds).not.toContain('file-1');
  });

  it('opens context menu on right-click', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    // No context menu initially
    expect(screen.queryByTestId('context-menu')).not.toBeInTheDocument();

    // Right-click file node
    await user.click(screen.getByRole('button', { name: 'Right-click first file' }));

    // Context menu should appear
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
  });

  it('expands freshly loaded chunk children from the context menu', async () => {
    const user = userEvent.setup();
    const loadFileChunkSummaries = vi.fn().mockResolvedValue([
      {
        id: 'loaded-chunk-1',
        fileRecordId: '1',
        chunkIndex: 0,
        tokenCount: 12,
        hasEmbedding: true,
        contentPreview: 'const one = 1;',
        embeddingSetId: 'collection-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'loaded-chunk-2',
        fileRecordId: '1',
        chunkIndex: 1,
        tokenCount: 10,
        hasEmbedding: false,
        contentPreview: 'const two = 2;',
        embeddingSetId: 'collection-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[]}
        height={500}
        loadFileChunkSummaries={loadFileChunkSummaries}
        records={[
          {
            id: '1',
            name: 'one.ts',
            path: '/one.ts',
            size: 100,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            chunksCount: 2,
            embeddingSetId: 'collection-1',
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Right-click first file' }));
    await user.click(screen.getByRole('button', { name: 'Expand All Children' }));

    expect(loadFileChunkSummaries).toHaveBeenCalledWith('1');
    expect(useCollectionBrowserStore.getState().expandedIds).toEqual([
      'file-1',
      'chunk-loaded-chunk-1',
    ]);
  });

  it('loads file chunk summaries when expanding all files from the toolbar', async () => {
    const user = userEvent.setup();
    const loadFileChunkSummaries = vi.fn().mockResolvedValue([
      {
        id: 'loaded-chunk-1',
        fileRecordId: '1',
        chunkIndex: 0,
        tokenCount: 12,
        hasEmbedding: true,
        embeddingSetId: 'collection-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[]}
        height={500}
        loadFileChunkSummaries={loadFileChunkSummaries}
        records={[
          {
            id: '1',
            name: 'one.ts',
            path: '/one.ts',
            size: 100,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            chunksCount: 1,
            embeddingSetId: 'collection-1',
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(loadFileChunkSummaries).toHaveBeenCalledWith('1');
    expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['file-1']);
  });

  it('deduplicates in-flight chunk summary loads when expand-all is triggered repeatedly', async () => {
    const user = userEvent.setup();
    let resolveLoad: ((value: DatabaseFileChunkSummary[]) => void) | null = null;
    const loadFileChunkSummaries = vi.fn(
      () =>
        new Promise<DatabaseFileChunkSummary[]>((resolve) => {
          resolveLoad = resolve;
        })
    );

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[]}
        height={500}
        loadFileChunkSummaries={loadFileChunkSummaries}
        records={[
          {
            id: '1',
            name: 'one.ts',
            path: '/one.ts',
            size: 100,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            chunksCount: 1,
            embeddingSetId: 'collection-1',
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    await user.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(loadFileChunkSummaries).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad?.([
        {
          id: 'loaded-chunk-1',
          fileRecordId: '1',
          chunkIndex: 0,
          chunkSize: 128,
          chunkType: 'text',
          contentHash: 'hash-1',
          tokenCount: 12,
          hasEmbedding: true,
          embeddingSetId: 'collection-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });
  });

  it('updates groupBy via toolbar', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    // Click group by status button
    await user.click(screen.getByRole('button', { name: 'Group by status' }));

    expect(useCollectionBrowserStore.getState().groupBy).toBe('status');
  });

  it('does not render context mutation controls for selected collection rows', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    expect(
      screen.queryByRole('button', { name: /add selected to context/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/in context:/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Select first file' }));
    expect(useCollectionBrowserStore.getState().selectedId).toBe('file-1');
    expect(
      screen.queryByRole('button', { name: /add selected to context/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear context/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(
      screen.queryByRole('button', { name: /add selected to context/i })
    ).not.toBeInTheDocument();
  });

  it('does not call onChunkSelect after unmount if chunk detail resolves late', async () => {
    let resolveChunkDetail!: (chunk: FileChunk | null) => void;
    const loadChunkDetail = vi.fn(
      () =>
        new Promise<FileChunk | null>((resolve) => {
          resolveChunkDetail = resolve;
        })
    );
    const onChunkSelect = vi.fn();

    const { unmount } = render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        loadChunkDetail={loadChunkDetail}
        onChunkSelect={onChunkSelect}
        records={TEST_RECORDS}
      />
    );

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0] as
      | {
          onSelect?: (nodeId: string, nodeType: string, nodeData: unknown) => void;
        }
      | undefined;

    expect(latestProps?.onSelect).toBeDefined();

    act(() => {
      latestProps?.onSelect?.('chunk-chunk-1', 'chunk', {});
    });

    unmount();

    await act(async () => {
      resolveChunkDetail(TEST_CHUNKS[0] ?? null);
      await Promise.resolve();
    });

    expect(onChunkSelect).not.toHaveBeenCalled();
  });

  it('handles chunk detail selection failures without unhandled rejections', async () => {
    const loadChunkDetail = vi.fn().mockRejectedValue(new Error('chunk detail failed'));
    const onChunkSelect = vi.fn();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        loadChunkDetail={loadChunkDetail}
        onChunkSelect={onChunkSelect}
        records={TEST_RECORDS}
      />
    );

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0] as
      | {
          onSelect?: (nodeId: string, nodeType: string, nodeData: unknown) => void;
        }
      | undefined;

    await act(async () => {
      latestProps?.onSelect?.('chunk-chunk-1', 'chunk', {});
      await Promise.resolve();
    });

    expect(loadChunkDetail).toHaveBeenCalledWith('chunk-1');
    expect(onChunkSelect).not.toHaveBeenCalled();
  });
});
