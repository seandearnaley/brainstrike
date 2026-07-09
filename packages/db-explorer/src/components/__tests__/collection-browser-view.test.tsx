import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { FileChunk, FileRecord } from '@brainstrike/db';
import { useCollectionBrowserColumnSizesStore } from '@brainstrike/preferences';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, MouseEvent, ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectionActions } from '../../context-actions';
import {
  __resetCollectionBrowserStoreForTests,
  useCollectionBrowserStore,
} from '../../stores/collection-browser-store';
import { CollectionBrowserView } from '../collection-browser-view';

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/context-actions')>();
  return {
    ...actual,
    createClipboardService: () => ({
      writeText: clipboardMocks.writeText,
    }),
  };
});

// Recreated per test (beforeEach) so writtenTexts never leaks across tests.
let testRegistry = createTestActionRegistry({ actions: collectionActions });

function RegistryWrapper({ children }: { children: ReactNode }) {
  return (
    <ActionRegistryProvider registry={testRegistry.registry}>{children}</ActionRegistryProvider>
  );
}

// All renders need the action registry: CollectionBrowserView mounts the
// shared ActionContextMenu, whose useActionRegistry throws without a provider.
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: RegistryWrapper });
}

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
    clearResults: semanticSearchMock.clearResults,
    executeSearch: semanticSearchMock.executeSearch,
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
    bulkActions?: Array<{ id: string; label: string; onAction: (ids: Set<string>) => void }>;
    onColumnSizesChange?: (sizes: Record<string, number>) => void;
    onExpandedIdsChange?: (ids: Set<string>) => void;
    onFiltersChange?: (filters: {
      embeddingStatus: string;
      nodeTypes: Set<string>;
      searchMatchesOnly: boolean;
      searchQuery: string;
    }) => void;
    onMultiSelect?: (ids: Set<string>) => void;
    onSortChange?: (sortState: { column: string; direction: 'asc' | 'desc' } | null) => void;
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
      onColumnSizesChange,
      onExpandedIdsChange,
      onFiltersChange,
      onSortChange,
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
        {bulkActions?.map((action) => (
          <button
            aria-label={`Bulk ${action.label}`}
            key={action.id}
            onClick={() =>
              action.onAction(new Set([`file-${firstFile?.id ?? '1'}`, 'chunk-chunk-1']))
            }
            type="button"
          >
            {`Bulk ${action.label}`}
          </button>
        ))}
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
              aria-label="Double-click first chunk"
              onClick={() => onDoubleClick?.('chunk-chunk-1', 'chunk', {})}
              type="button"
            >
              Double-click chunk
            </button>
            <button
              aria-label="Double-click first embedding"
              onClick={() => onDoubleClick?.('embedding-chunk-1', 'embedding', {})}
              type="button"
            >
              Double-click embedding
            </button>
            {/* Right-click rows claim the shared context-menu target on the
                REAL contextmenu event so Radix's ContextMenu can open. */}
            <button
              aria-label="Right-click first file"
              onContextMenu={(e) =>
                onContextMenu?.(
                  `file-${firstFile.id}`,
                  'file',
                  { name: 'one.ts', path: '/one.ts' },
                  e as unknown as MouseEvent
                )
              }
              type="button"
            >
              Right-click file
            </button>
            <button
              aria-label="Right-click first chunk"
              onContextMenu={(e) =>
                onContextMenu?.(
                  'chunk-chunk-1',
                  'chunk',
                  { content: 'const one = 1;' },
                  e as unknown as MouseEvent
                )
              }
              type="button"
            >
              Right-click chunk
            </button>
            <button
              aria-label="Right-click collection"
              onContextMenu={(e) =>
                onContextMenu?.('collection-current', 'collection', {}, e as unknown as MouseEvent)
              }
              type="button"
            >
              Right-click collection
            </button>
            <button
              aria-label="Right-click group"
              onContextMenu={(e) =>
                onContextMenu?.('group-status-complete', 'group', {}, e as unknown as MouseEvent)
              }
              type="button"
            >
              Right-click group
            </button>
            <button
              aria-label="Multi-select"
              onClick={() => onMultiSelect?.(new Set([`file-${firstFile.id}`]))}
              type="button"
            >
              Multi-select
            </button>
            <button
              aria-label="Apply expanded ids"
              onClick={() => onExpandedIdsChange?.(new Set([`file-${firstFile.id}`]))}
              type="button"
            >
              Apply expanded ids
            </button>
            <button
              aria-label="Apply filters"
              onClick={() =>
                onFiltersChange?.({
                  embeddingStatus: 'complete',
                  nodeTypes: new Set(['file', 'chunk']),
                  searchMatchesOnly: false,
                  searchQuery: 'needle',
                })
              }
              type="button"
            >
              Apply filters
            </button>
            <button
              aria-label="Apply sort"
              onClick={() => onSortChange?.({ column: 'size', direction: 'desc' })}
              type="button"
            >
              Apply sort
            </button>
            <button
              aria-label="Apply column sizes"
              onClick={() => onColumnSizesChange?.({ name: 444, size: 123 })}
              type="button"
            >
              Apply column sizes
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
        <button
          aria-label="Select malformed id"
          onClick={() => onSelectedIdChange?.('workspace-root')}
          type="button"
        >
          Select malformed id
        </button>
      </div>
    );
  };

  const NodeInspector = ({
    nodeData,
    nodeId,
    nodeType,
  }: {
    nodeData?: unknown;
    nodeId?: string;
    nodeType: string | null;
  }) => (
    <div data-node-data={JSON.stringify(nodeData ?? null)} data-testid="node-inspector">
      {`${nodeType ?? 'none'}:${nodeId ?? ''}`}
    </div>
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
    disabled,
    isSearchExpanded,
    onSemanticSearch,
    onSearchExpandedChange,
    onModeChange,
    onSemanticQueryChange,
  }: {
    advancedOptions?: ReactNode;
    disabled?: boolean;
    isSearchExpanded?: boolean;
    onModeChange?: (mode: string) => void;
    onSemanticSearch?: () => void;
    onSearchExpandedChange?: (expanded: boolean) => void;
    onSemanticQueryChange?: (query: string) => void;
  }) => (
    <div data-testid="search-mode-bar">
      <button
        // Match production's dynamic aria-label so downstream tests verify
        // the real component's behavior instead of the mock.
        aria-expanded={isSearchExpanded ? 'true' : 'false'}
        aria-label={isSearchExpanded ? 'Collapse hybrid search' : 'Expand hybrid search'}
        disabled={disabled}
        onClick={() => onSearchExpandedChange?.(!isSearchExpanded)}
        type="button"
      >
        Hybrid search
      </button>
      <button
        aria-label="Run hybrid search"
        disabled={disabled}
        onClick={onSemanticSearch}
        type="button"
      >
        Run hybrid search
      </button>
      <button
        aria-label="Set semantic query"
        onClick={() => onSemanticQueryChange?.('mock semantic query')}
        type="button"
      >
        Set semantic query
      </button>
      <button aria-label="Switch quick mode" onClick={() => onModeChange?.('quick')} type="button">
        Switch quick mode
      </button>
      <button
        aria-label="Switch semantic mode"
        onClick={() => onModeChange?.('semantic')}
        type="button"
      >
        Switch semantic mode
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
  const SearchConfigPanel = ({
    onConfigChange,
  }: {
    onConfigChange?: (config: {
      threshold: number;
      resultLimit: number;
      distanceMetric: 'cosine';
      retrievalMode: 'hybrid';
      vectorWeight: number;
      ftsWeight: number;
    }) => void;
  }) => (
    <div data-testid="search-config-panel">
      <button
        aria-label="Apply search config"
        onClick={() =>
          onConfigChange?.({
            distanceMetric: 'cosine',
            ftsWeight: 0.3,
            resultLimit: 17,
            retrievalMode: 'hybrid',
            threshold: 0.42,
            vectorWeight: 0.7,
          })
        }
        type="button"
      >
        Apply search config
      </button>
    </div>
  );
  const FilterBar = () => <div data-testid="filter-bar" />;

  return {
    ...actual,
    Button,
    CollectionBrowser,
    CollectionBrowserToolbar,
    FilterBar,
    NodeInspector,
    SearchConfigPanel,
    SearchModeBar,
    TablePagination,
  };
});

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: ReactNode }) => <div data-testid="panel-group">{children}</div>,
  Panel: ({
    children,
    id,
    onResize,
  }: {
    children: ReactNode;
    id?: string;
    onResize?: (panelSize: { asPercentage: number }) => void;
  }) => (
    <div data-testid={id ? `panel-${id}` : 'panel-main'}>
      {children}
      {id === 'inspector-panel' && (
        <button
          aria-label="Resize inspector to zero"
          onClick={() => onResize?.({ asPercentage: 0 })}
          type="button"
        >
          Resize inspector to zero
        </button>
      )}
    </div>
  ),
  Separator: () => <div data-testid="resize-handle" />,
}));

const TEST_RECORDS: FileRecord[] = [
  {
    createdAt: '2026-01-01T00:00:00.000Z',
    id: '1',
    name: 'one.ts',
    path: '/one.ts',
    size: 100,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const TEST_CHUNKS: FileChunk[] = [
  {
    chunkIndex: 0,
    chunkSize: 16,
    chunkType: 'code',
    content: 'const one = 1;',
    contentHash: 'chunk-hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    fileRecordId: '1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** Open the shared context menu by firing a REAL contextmenu event on a mock row. */
async function openContextMenuOn(rowButtonName: string): Promise<void> {
  fireEvent.contextMenu(screen.getByRole('button', { name: rowButtonName }), {
    clientX: 10,
    clientY: 10,
  });
  await screen.findByRole('menu');
}

/**
 * Deterministic teardown for Radix's FocusScope: its effect cleanup defers
 * focus-restore in a setTimeout(0). A test that returns with the menu still
 * open (or just closed) leaks that timer; it then fires during the NEXT test,
 * focuses body, and the new menu's onFocusOutside dismisses it mid-assertion.
 * Close the menu while still mounted, then flush the 0ms timer.
 */
async function closeMenuAndFlushFocusRestore(): Promise<void> {
  if (screen.queryByRole('menu')) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  }
  await act(
    () =>
      new Promise((resolve) => {
        setTimeout(resolve, 0);
      })
  );
}

/** Click a context-menu item, then wait for the menu to close and flush focus restore. */
async function clickMenuItem(itemName: string): Promise<void> {
  fireEvent.click(screen.getByRole('menuitem', { name: itemName }));
  await waitFor(() => {
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  await act(
    () =>
      new Promise((resolve) => {
        setTimeout(resolve, 0);
      })
  );
}

describe('CollectionBrowserView', () => {
  beforeEach(() => {
    __resetCollectionBrowserStoreForTests();
    useCollectionBrowserColumnSizesStore.getState().setAll({});
    clipboardMocks.writeText.mockReset();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
    vi.clearAllMocks();
    semanticSearchMock.state = {
      error: null,
      hasSearched: false,
      isSearching: false,
      searchResults: [],
    };
    collectionBrowserPropsSpy.mockClear();
    testRegistry = createTestActionRegistry({ actions: collectionActions });
  });

  afterEach(async () => {
    // Runs BEFORE RTL auto-cleanup (vitest afterEach hooks run in reverse
    // registration order; auto-cleanup registers in the setup file), so the
    // menu is still mounted here and can be closed deterministically.
    await closeMenuAndFlushFocusRestore();
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

  it('applies browser callback changes to persisted collection browser state', async () => {
    const user = userEvent.setup();
    const loadFileChunkSummaries = vi.fn().mockResolvedValue([]);

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[]}
        height={500}
        loadFileChunkSummaries={loadFileChunkSummaries}
        records={[
          {
            ...TEST_RECORDS[0]!,
            chunksCount: 1,
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(useCollectionBrowserStore.getState()).toMatchObject({
      embeddingStatus: 'complete',
      nodeTypes: ['file', 'chunk'],
      searchQuery: 'needle',
    });

    await user.click(screen.getByRole('button', { name: 'Apply sort' }));
    expect(useCollectionBrowserStore.getState().sortState).toEqual({
      column: 'size',
      direction: 'desc',
    });

    await user.click(screen.getByRole('button', { name: 'Apply column sizes' }));
    expect(useCollectionBrowserColumnSizesStore.getState().sizes).toMatchObject({
      name: 444,
      size: 123,
    });

    await user.click(screen.getByRole('button', { name: 'Apply expanded ids' }));
    expect(loadFileChunkSummaries).toHaveBeenCalledWith('1');
    expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['file-1']);
  });

  it('runs browser bulk actions against selected node ids', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Bulk Expand' }));
    expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['file-1', 'chunk-chunk-1']);

    await user.click(screen.getByRole('button', { name: 'Bulk Collapse' }));
    expect(useCollectionBrowserStore.getState().expandedIds).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Bulk Copy IDs' }));
    await waitFor(() => {
      expect(clipboardMocks.writeText).toHaveBeenCalledWith('1\nchunk-1');
    });
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

    await user.click(screen.getByRole('button', { name: /^expand hybrid search$/i }));

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

  it('keeps hybrid search discoverable when no collection is selected', () => {
    render(
      <CollectionBrowserView activeCollectionId={null} chunks={[]} height={500} records={[]} />
    );

    expect(screen.getByRole('button', { name: /^expand hybrid search$/i })).toBeInTheDocument();
    expect(screen.getByTestId('search-mode-bar')).toBeInTheDocument();
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

  it('does not execute hybrid search for the protected workspace index collection', async () => {
    const user = userEvent.setup();
    useCollectionBrowserStore.getState().setSemanticQuery('workspace query');
    useCollectionBrowserStore.getState().setSearchPanelExpanded(true);

    render(
      <CollectionBrowserView
        activeCollectionId="workspace-index"
        activeCollectionSystemRole="workspace-index"
        chunks={[]}
        height={500}
        records={[]}
      />
    );

    expect(screen.getByRole('button', { name: /collapse hybrid search/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run hybrid search' })).toBeDisabled();
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
        chunks: [
          expect.objectContaining({
            chunkIndex: 7,
            embeddingDimensions: 1536,
            hasEmbedding: true,
            id: 'result-chunk',
            tokenCount: 128,
          }),
        ],
        files: [
          expect.objectContaining({
            id: 'result-file',
            size: 4096,
          }),
        ],
      },
    });
  });

  it('filters active collection data and preserves optional tree metadata', () => {
    render(
      <CollectionBrowserView
        activeCollectionId="collection-1"
        chunks={[
          {
            ...TEST_CHUNKS[0]!,
            embeddingDimensions: 1536,
            embeddingSetId: 'collection-1',
            hasEmbedding: true,
          },
          {
            ...TEST_CHUNKS[0]!,
            embeddingSetId: 'collection-2',
            fileRecordId: 'other-file',
            id: 'other-chunk',
          },
        ]}
        height={500}
        pendingChunkIds={new Set(['chunk-1'])}
        records={[
          {
            ...TEST_RECORDS[0]!,
            chunksCount: 2,
            embeddedChunksCount: 1,
            embeddingSetId: 'collection-1',
            processedAt: '2026-01-02T00:00:00.000Z',
          },
          {
            ...TEST_RECORDS[0]!,
            embeddingSetId: 'collection-2',
            id: 'other-file',
          },
        ]}
      />
    );

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestProps).toMatchObject({
      data: {
        chunks: [
          expect.objectContaining({
            embeddingDimensions: 1536,
            embeddingSetId: 'collection-1',
            hasEmbedding: true,
            id: 'chunk-1',
          }),
        ],
        files: [
          expect.objectContaining({
            chunksCount: 2,
            embeddedChunksCount: 1,
            embeddingSetId: 'collection-1',
            id: '1',
            processedAt: '2026-01-02T00:00:00.000Z',
          }),
        ],
        pendingChunkIds: new Set(['chunk-1']),
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

  it('hides the file-list pagination while scoped semantic search results are displayed', () => {
    // Regression: in semantic/hybrid search the tree is built from the bounded
    // search-result set, NOT the paginated file list. Showing the file-list pager
    // (which implies many pages for a large collection) is misleading — paging it
    // only refetches records (a loading flash) without changing the visible results.
    act(() => {
      useCollectionBrowserStore.getState().setSearchMode('semantic');
    });
    semanticSearchMock.state = {
      error: null,
      hasSearched: true,
      isSearching: false,
      searchResults: [
        {
          chunkId: 'hit-1',
          chunkIndex: 0,
          content: 'semantic hit one',
          embeddingSetId: 'set-1',
          fileName: 'alpha.ts',
          filePath: '/alpha.ts',
          fileRecordId: 'file-a',
          tokenCount: 5,
        },
        {
          chunkId: 'hit-2',
          chunkIndex: 0,
          content: 'semantic hit two',
          embeddingSetId: 'set-1',
          fileName: 'beta.ts',
          filePath: '/beta.ts',
          fileRecordId: 'file-b',
          tokenCount: 5,
        },
      ],
    };

    render(
      <CollectionBrowserView
        activeCollectionId="set-1"
        chunks={TEST_CHUNKS}
        height={500}
        pagination={{
          currentPage: 1,
          onPageChange: vi.fn(),
          onPageSizeChange: vi.fn(),
          pageSize: 50,
          totalRecords: 5000,
        }}
        records={TEST_RECORDS}
      />
    );

    expect(screen.queryByTestId('table-pagination')).not.toBeInTheDocument();
  });

  it('still renders the file-list pagination in quick mode for an active collection', () => {
    act(() => {
      useCollectionBrowserStore.getState().setSearchMode('quick');
    });

    render(
      <CollectionBrowserView
        activeCollectionId="set-1"
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

    expect(screen.getByTestId('table-pagination')).toHaveTextContent('1:50:120:3');
  });

  it('renders semantic search errors from the search context', () => {
    semanticSearchMock.state = {
      error: 'search failed',
      hasSearched: false,
      isSearching: false,
      searchResults: [],
    };

    render(
      <CollectionBrowserView
        activeCollectionId="set-1"
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    expect(screen.getByText('search failed')).toBeInTheDocument();
  });

  it('persists search config changes and clears stale results when switching to quick mode', async () => {
    const user = userEvent.setup();
    act(() => {
      useCollectionBrowserStore.getState().setSearchPanelExpanded(true);
      useCollectionBrowserStore.getState().setSearchMode('semantic');
    });

    render(
      <CollectionBrowserView
        activeCollectionId="set-1"
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Apply search config' }));
    expect(useCollectionBrowserStore.getState()).toMatchObject({
      searchConfigDistanceMetric: 'cosine',
      searchConfigFtsWeight: 0.3,
      searchConfigLimit: 17,
      searchConfigRetrievalMode: 'hybrid',
      searchConfigThreshold: 0.42,
      searchConfigVectorWeight: 0.7,
    });

    await user.click(screen.getByRole('button', { name: 'Switch quick mode' }));
    expect(useCollectionBrowserStore.getState().searchMode).toBe('quick');
    expect(semanticSearchMock.clearResults).toHaveBeenCalledOnce();
  });

  it('updates semantic query and executes scoped search for an active collection', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId="set-1"
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Set semantic query' }));
    expect(useCollectionBrowserStore.getState().semanticQuery).toBe('mock semantic query');

    await user.click(screen.getByRole('button', { name: 'Run hybrid search' }));
    expect(useCollectionBrowserStore.getState().searchMode).toBe('semantic');
    expect(semanticSearchMock.executeSearch).toHaveBeenCalledWith(
      'mock semantic query',
      expect.objectContaining({
        resultLimit: expect.any(Number),
        threshold: expect.any(Number),
      }),
      'set-1'
    );
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

  it('double-clicks chunk nodes for expansion and embedding nodes for inspection', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[
          {
            ...TEST_CHUNKS[0]!,
            embeddingDimensions: 2,
            hasEmbedding: true,
          },
        ]}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Double-click first chunk' }));
    expect(useCollectionBrowserStore.getState().expandedIds).toContain('chunk-chunk-1');

    await user.click(screen.getByRole('button', { name: 'Double-click first embedding' }));
    expect(useCollectionBrowserStore.getState().selectedId).toBe('embedding-chunk-1');
    expect(screen.getByTestId('node-inspector')).toHaveTextContent('embedding:chunk-1');
  });

  it('ignores malformed selected ids when deriving inspector state', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Select malformed id' }));

    expect(useCollectionBrowserStore.getState().selectedId).toBe('workspace-root');
    expect(screen.queryByTestId('panel-inspector-panel')).not.toBeInTheDocument();
  });

  it('loads selected chunk detail for inspector data', async () => {
    act(() => {
      useCollectionBrowserStore.getState().setSelectedId('chunk-chunk-1');
    });
    const detailedChunk: FileChunk = {
      ...TEST_CHUNKS[0]!,
      content: 'resolved chunk content',
      embedding: [0.1, 0.2, 0.3],
    };
    const loadChunkDetail = vi.fn().mockResolvedValue(detailedChunk);

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[
          {
            ...TEST_CHUNKS[0]!,
            hasEmbedding: false,
          },
        ]}
        height={500}
        loadChunkDetail={loadChunkDetail}
        records={TEST_RECORDS}
      />
    );

    expect(screen.getByTestId('node-inspector')).toHaveAttribute(
      'data-node-data',
      expect.stringContaining('Loading chunk content...')
    );

    await waitFor(() =>
      expect(screen.getByTestId('node-inspector')).toHaveAttribute(
        'data-node-data',
        expect.stringContaining('resolved chunk content')
      )
    );
    expect(screen.getByTestId('node-inspector')).toHaveAttribute(
      'data-node-data',
      expect.stringContaining('"embeddingStatus":"complete"')
    );
  });

  it('opens context menu on right-click', async () => {
    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    // No context menu initially
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // Right-click file node
    await openContextMenuOn('Right-click first file');

    // Shared action context menu should appear with registry + local actions
    expect(screen.getByRole('menuitem', { name: 'Copy ID' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Inspect' })).toBeInTheDocument();
  });

  it('does not open a context menu on group headers', () => {
    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    // Intentional v1 simplification: group headers map to no context target.
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Right-click group' }), {
      clientX: 10,
      clientY: 10,
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('copies and selects context-menu node ids', async () => {
    const user = userEvent.setup();

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await openContextMenuOn('Right-click first file');
    // Select is hidden until multi-select is enabled
    expect(screen.queryByRole('menuitem', { name: 'Select' })).not.toBeInTheDocument();
    await clickMenuItem('Copy ID');

    await waitFor(() => {
      expect(testRegistry.writtenTexts).toEqual(['1']);
    });

    await user.click(screen.getByRole('button', { name: 'Toggle multi-select' }));
    await openContextMenuOn('Right-click first file');
    await clickMenuItem('Select');

    expect(useCollectionBrowserStore.getState().selectedId).toBe('file-1');
  });

  it('copies chunk content from the context menu', async () => {
    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await openContextMenuOn('Right-click first chunk');
    await clickMenuItem('Copy Content');

    await waitFor(() => {
      expect(testRegistry.writtenTexts).toEqual(['const one = 1;']);
    });
  });

  it('handles collection and chunk context menu expansion branches', async () => {
    render(
      <CollectionBrowserView
        activeCollectionId="collection-1"
        chunks={[
          {
            ...TEST_CHUNKS[0]!,
            embeddingSetId: 'collection-1',
            hasEmbedding: true,
          },
        ]}
        height={500}
        records={[
          {
            ...TEST_RECORDS[0]!,
            chunksCount: 1,
            embeddingSetId: 'collection-1',
          },
        ]}
      />
    );

    await openContextMenuOn('Right-click collection');
    await clickMenuItem('Expand');
    expect(useCollectionBrowserStore.getState().expandedIds).toContain('collection-current');

    await openContextMenuOn('Right-click first chunk');
    await clickMenuItem('Expand');
    expect(useCollectionBrowserStore.getState().expandedIds).toContain('chunk-chunk-1');

    // Label flips once the node is expanded
    await openContextMenuOn('Right-click first chunk');
    expect(screen.getByRole('menuitem', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('expands freshly loaded chunk children from the context menu', async () => {
    const loadFileChunkSummaries = vi.fn().mockResolvedValue([
      {
        chunkIndex: 0,
        contentPreview: 'const one = 1;',
        createdAt: '2026-01-01T00:00:00.000Z',
        embeddingSetId: 'collection-1',
        fileRecordId: '1',
        hasEmbedding: true,
        id: 'loaded-chunk-1',
        tokenCount: 12,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        chunkIndex: 1,
        contentPreview: 'const two = 2;',
        createdAt: '2026-01-01T00:00:00.000Z',
        embeddingSetId: 'collection-1',
        fileRecordId: '1',
        hasEmbedding: false,
        id: 'loaded-chunk-2',
        tokenCount: 10,
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
            chunksCount: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            embeddingSetId: 'collection-1',
            id: '1',
            name: 'one.ts',
            path: '/one.ts',
            size: 100,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
      />
    );

    await openContextMenuOn('Right-click first file');
    await clickMenuItem('Expand All Children');

    await waitFor(() => {
      expect(useCollectionBrowserStore.getState().expandedIds).toEqual([
        'file-1',
        'chunk-loaded-chunk-1',
      ]);
    });
    expect(loadFileChunkSummaries).toHaveBeenCalledWith('1');
  });

  it('loads file chunk summaries when expanding all files from the toolbar', async () => {
    const user = userEvent.setup();
    const loadFileChunkSummaries = vi.fn().mockResolvedValue([
      {
        chunkIndex: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        embeddingSetId: 'collection-1',
        fileRecordId: '1',
        hasEmbedding: true,
        id: 'loaded-chunk-1',
        tokenCount: 12,
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
            chunksCount: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            embeddingSetId: 'collection-1',
            id: '1',
            name: 'one.ts',
            path: '/one.ts',
            size: 100,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(loadFileChunkSummaries).toHaveBeenCalledWith('1');
    expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['file-1']);
  });

  it('uses already loaded chunks when expanding all files from the toolbar', async () => {
    const user = userEvent.setup();
    const loadFileChunkSummaries = vi.fn().mockResolvedValue([]);

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        loadFileChunkSummaries={loadFileChunkSummaries}
        records={[
          {
            ...TEST_RECORDS[0]!,
            chunksCount: 1,
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(loadFileChunkSummaries).not.toHaveBeenCalled();
    expect(useCollectionBrowserStore.getState().expandedIds).toEqual(['file-1']);
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

  it('materializes large collections without dropping records', () => {
    const largeRecordSet = Array.from({ length: 250 }, (_, index): FileRecord => {
      const id = `large-${index}`;
      return {
        createdAt: '2026-01-01T00:00:00.000Z',
        id,
        name: `${id}.ts`,
        path: `/${id}.ts`,
        size: index + 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
    });

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={[]}
        height={500}
        records={largeRecordSet}
      />
    );

    const latestProps = collectionBrowserPropsSpy.mock.calls.at(-1)?.[0];
    expect(latestProps).toMatchObject({
      data: {
        files: expect.arrayContaining([
          expect.objectContaining({ id: 'large-0' }),
          expect.objectContaining({ id: 'large-249' }),
        ]),
      },
    });
  });

  it('calls selection callbacks for file and chunk nodes that resolve details', async () => {
    const user = userEvent.setup();
    const onFileSelect = vi.fn();
    const onChunkSelect = vi.fn();
    const loadChunkDetail = vi.fn().mockResolvedValue(TEST_CHUNKS[0]);

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        loadChunkDetail={loadChunkDetail}
        onChunkSelect={onChunkSelect}
        onFileSelect={onFileSelect}
        records={TEST_RECORDS}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Select first file' }));
    expect(onFileSelect).toHaveBeenCalledWith('1', TEST_RECORDS[0]);

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
    expect(onChunkSelect).toHaveBeenCalledWith('chunk-1', TEST_CHUNKS[0]);
  });

  it('opens the inspector from the context menu when it starts collapsed', async () => {
    act(() => {
      useCollectionBrowserStore.getState().setInspectorCollapsed(true);
    });

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await openContextMenuOn('Right-click first file');
    await clickMenuItem('Inspect');

    expect(useCollectionBrowserStore.getState()).toMatchObject({
      isInspectorCollapsed: false,
      selectedId: 'file-1',
    });
    expect(screen.getByTestId('node-inspector')).toHaveTextContent('file:1');
  });

  it('reopens and collapses the inspector through panel controls', async () => {
    const user = userEvent.setup();
    act(() => {
      useCollectionBrowserStore.getState().setSelectedId('file-1');
      useCollectionBrowserStore.getState().setInspectorCollapsed(true);
    });

    render(
      <CollectionBrowserView
        activeCollectionId={null}
        chunks={TEST_CHUNKS}
        height={500}
        records={TEST_RECORDS}
      />
    );

    await user.click(screen.getByRole('button', { name: /show inspector panel/i }));
    expect(useCollectionBrowserStore.getState().isInspectorCollapsed).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Resize inspector to zero' }));
    expect(useCollectionBrowserStore.getState().isInspectorCollapsed).toBe(true);
  });
});
