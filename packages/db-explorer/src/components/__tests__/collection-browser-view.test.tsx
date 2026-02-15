import type { FileChunk, FileRecord } from '@brainstrike/db';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
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
  }: {
    data: { files: Array<{ id: string }> };
    onSelect?: (nodeId: string, nodeType: string, nodeData: unknown) => void;
    onSelectedIdChange?: (id: string | null) => void;
  }) => {
    const firstFile = data.files[0];

    return (
      <div data-testid="collection-browser">
        {firstFile ? (
          <button
            aria-label="Select first file"
            onClick={() => onSelect?.(`file-${firstFile.id}`, 'file', {})}
            type="button"
          >
            Select first file
          </button>
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

  const SearchModeBar = () => <div data-testid="search-mode-bar" />;
  const SearchConfigPanel = () => <div data-testid="search-config-panel" />;
  const FilterBar = () => <div data-testid="filter-bar" />;

  return {
    ...actual,
    Button,
    CollectionBrowser,
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
});
