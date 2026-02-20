import type { FileChunk, FileRecord } from '@brainstrike/db';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCollectionBrowserStoreForTests,
  useCollectionBrowserStore,
} from '../../stores/collection-browser-store';
import { CollectionBrowserView } from '../collection-browser-view';

vi.mock('../../contexts/semantic-search-context', () => ({
  useSemanticSearch: () => ({
    searchResults: [],
    isSearching: false,
    hasSearched: false,
    error: null,
    executeSearch: vi.fn(),
    clearResults: vi.fn(),
  }),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();

  const Button = ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  );

  const CollectionBrowser = ({
    data,
    onSelect,
    onSelectedIdChange,
    multiSelectEnabled,
    onDoubleClick,
    onContextMenu,
    bulkActions,
    onMultiSelect,
    showCheckbox,
  }: {
    data: { files: Array<{ id: string }> };
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
    showCheckbox?: boolean;
  }) => {
    const firstFile = data.files[0];

    return (
      <div data-testid="collection-browser">
        {multiSelectEnabled && <span data-testid="multi-select-enabled" />}
        {showCheckbox && <span data-testid="show-checkbox" />}
        {bulkActions && bulkActions.length > 0 && (
          <span data-testid="bulk-actions-count">{bulkActions.length}</span>
        )}
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

  const SearchModeBar = ({
    multiSelectEnabled,
    onMultiSelectToggle,
    groupBy,
    onGroupByChange,
  }: {
    multiSelectEnabled?: boolean;
    onMultiSelectToggle?: (enabled: boolean) => void;
    groupBy?: string;
    onGroupByChange?: (key: string) => void;
  }) => (
    <div data-testid="search-mode-bar">
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    FilterBar,
    NodeInspector,
    SearchConfigPanel,
    SearchModeBar,
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
});
