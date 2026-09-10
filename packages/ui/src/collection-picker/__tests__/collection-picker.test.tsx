import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import { CollectionPicker } from '../collection-picker';
import { getCollectionPickerProtection } from '../protection';
import type { CollectionPickerCollection } from '../types';
import {
  extractProviderId,
  formatProviderLabel,
  getCollectionColor,
} from '../utils/collection-colors';

// Mock useTheme
vi.mock('../../theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useTheme: () => ({
    mode: 'light',
    setMode: vi.fn(),
  }),
}));

// Mock ScrollArea because it might need ResizeObserver or other browser APIs
vi.mock('../../scroll-area', () => ({
  ScrollArea: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div data-testid="scroll-area" style={style}>
      {children}
    </div>
  ),
}));

const mockCollections: CollectionPickerCollection[] = [
  {
    category: null,
    chunkCount: 100,
    createdAt: new Date().toISOString(),
    description: 'Description 1',
    dimensions: 1536,
    distance: 'cosine',
    embeddingCount: 100,
    fileCount: 10,
    id: '1',
    modelId: 'text-embedding-3-small',
    modelKey: 'openai::text-embedding-3-small',
    name: 'Collection 1',
    tags: null,
  },
  {
    category: null,
    chunkCount: 50,
    createdAt: new Date().toISOString(),
    description: null,
    dimensions: 1024,
    distance: 'cosine',
    embeddingCount: 50,
    fileCount: 5,
    id: '2',
    modelId: 'bge-m3',
    modelKey: 'local::Xenova/bge-m3',
    name: null,
    tags: null,
  },
];

const workspaceIndexCollection: CollectionPickerCollection = {
  category: null,
  chunkCount: 420,
  createdAt: new Date().toISOString(),
  description: 'System-managed workspace index for assistant retrieval.',
  dimensions: 1536,
  distance: 'cosine',
  embeddingCount: 300,
  fileCount: 42,
  id: 'workspace-index',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
  name: 'Workspace Index',
  systemRole: 'workspace-index',
  tags: null,
};

describe('CollectionPicker', () => {
  const defaultProps = {
    collections: mockCollections,
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onSelect: vi.fn(),
    selectedId: null,
  };

  const renderWithProvider = (ui: React.ReactElement) =>
    render(<TooltipProvider>{ui}</TooltipProvider>);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders collections correctly', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    expect(screen.getByText('Collection 1')).toBeInTheDocument();
    expect(screen.getByText('bge-m3')).toBeInTheDocument();
    expect(screen.getByText('Openai')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} collections={[]} loading={true} />);

    expect(screen.getByText('Loading collections...')).toBeInTheDocument();
  });

  it('keeps cached collections visible while a refresh is in flight', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} loading={true} />);

    expect(screen.getByText('Collection 1')).toBeInTheDocument();
    expect(screen.queryByText('Loading collections...')).not.toBeInTheDocument();
  });

  it('shows empty state', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} collections={[]} />);

    expect(screen.getByText(/No collections yet/i)).toBeInTheDocument();
  });

  it('calls onSelect when an item is clicked', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    fireEvent.click(screen.getByText('Collection 1'));
    expect(defaultProps.onSelect).toHaveBeenCalledWith('1');
  });

  it('handles keyboard navigation (arrow keys)', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    const listbox = screen.getByRole('listbox');

    // Trigger ArrowDown to enable keyboard focus state and move to index 1
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getByText('bge-m3').closest('[role="option"]')).toHaveClass('ring-2');

    // ArrowUp back to index 0
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(screen.getByText('Collection 1').closest('[role="option"]')).toHaveClass('ring-2');
  });

  it('handles Home, End, blur, and pointer focus transitions', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'End' });
    expect(screen.getByText('bge-m3').closest('[role="option"]')).toHaveClass('ring-2');

    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(screen.getByText('Collection 1').closest('[role="option"]')).toHaveClass('ring-2');

    fireEvent.blur(listbox);
    expect(screen.getByText('Collection 1').closest('[role="option"]')).not.toHaveClass('ring-2');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getByText('bge-m3').closest('[role="option"]')).toHaveClass('ring-2');

    fireEvent.pointerDown(listbox);
    expect(screen.getByText('bge-m3').closest('[role="option"]')).not.toHaveClass('ring-2');
  });

  it('handles keyboard selection (Enter/Space)', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    const listbox = screen.getByRole('listbox');
    listbox.focus();

    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(defaultProps.onSelect).toHaveBeenCalledWith('1');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: ' ' });
    expect(defaultProps.onSelect).toHaveBeenCalledWith('2');
  });

  it('uses the icon-xs size token for collection action buttons', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    expect(screen.getAllByRole('button', { name: 'Edit collection' })[0]).toHaveAttribute(
      'data-size',
      'icon-xs'
    );
    expect(screen.getAllByRole('button', { name: 'Delete collection' })[0]).toHaveAttribute(
      'data-size',
      'icon-xs'
    );
  });

  it('routes edit and delete actions without selecting the collection', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    const firstOption = screen.getByRole('option', { name: /Collection 1/ });

    fireEvent.click(within(firstOption).getByRole('button', { name: 'Edit collection' }));
    fireEvent.click(within(firstOption).getByRole('button', { name: 'Delete collection' }));

    expect(defaultProps.onEdit).toHaveBeenCalledWith(mockCollections[0]);
    expect(defaultProps.onDelete).toHaveBeenCalledWith(mockCollections[0]);
    expect(defaultProps.onSelect).not.toHaveBeenCalled();
  });

  it('uses selected styling, singular metadata labels, and a custom scroll height without a visible header', () => {
    const baseCollection = mockCollections[0];
    if (!baseCollection) {
      throw new Error('Expected at least one mock collection');
    }
    const singularCollection: CollectionPickerCollection = {
      ...baseCollection,
      chunkCount: 1,
      embeddingCount: 0,
      fileCount: 1,
      id: 'single',
      name: 'Single file collection',
    };

    renderWithProvider(
      <CollectionPicker
        {...defaultProps}
        collections={[singularCollection]}
        headerLabel="Memory Set"
        maxHeight="144px"
        selectedId="single"
        showHeader={false}
      />
    );

    const listbox = screen.getByRole('listbox', { name: 'Memory Set' });
    const option = screen.getByRole('option', {
      name: /Single file collection, Openai, 1536 dimensions, cosine, 1 file, 1 chunk, 0 of 1 chunks embedded/,
    });

    expect(listbox).not.toHaveAttribute('aria-labelledby');
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(option).toHaveStyle({
      backgroundColor: getCollectionColor('single', 'light').background,
      borderLeftColor: getCollectionColor('single', 'light').primary,
    });
    expect(screen.queryByText('Memory Set')).not.toBeInTheDocument();
    expect(screen.getByTestId('scroll-area')).toHaveStyle({ maxHeight: '144px' });
  });

  it('renders a custom empty state and invokes the header create action', () => {
    renderWithProvider(
      <CollectionPicker
        {...defaultProps}
        collections={[]}
        emptyState={<p>No matching collections</p>}
        headerLabel="Custom Collections"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByText('Custom Collections')).toBeInTheDocument();
    expect(screen.getByText('No matching collections')).toBeInTheDocument();
    expect(screen.queryByText(/No collections yet/i)).not.toBeInTheDocument();
    expect(defaultProps.onCreate).toHaveBeenCalledTimes(1);
  });

  it('includes embedding progress in the option label without nesting an extra tab stop', () => {
    renderWithProvider(<CollectionPicker {...defaultProps} />);

    expect(
      screen.getByRole('option', {
        name: /Collection 1, Openai, 1536 dimensions, cosine, 10 files, 100 chunks, 100 of 100 chunks embedded/,
      })
    ).toBeInTheDocument();

    const [embeddedLabel] = screen.getAllByText('embedded');
    if (!embeddedLabel) {
      throw new Error('Expected embedded count label to render');
    }

    expect(embeddedLabel.closest('button')).toBeNull();
    expect(embeddedLabel.parentElement).not.toHaveAttribute('tabindex');
  });

  it('renders the workspace index as visible but protected', () => {
    renderWithProvider(
      <CollectionPicker
        {...defaultProps}
        collections={[workspaceIndexCollection, ...mockCollections]}
      />
    );

    const workspaceOption = screen.getByRole('option', { name: /Workspace Index/ });
    expect(workspaceOption).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Workspace Index')).toBeInTheDocument();
    expect(screen.getByText('Workspace index')).toBeInTheDocument();
    expect(screen.getByText('Managed by Brainstrike for assistant retrieval')).toBeInTheDocument();

    fireEvent.click(workspaceOption);

    expect(defaultProps.onSelect).not.toHaveBeenCalled();
    expect(within(workspaceOption).queryByRole('button', { name: 'Edit collection' })).toBeNull();
    expect(within(workspaceOption).queryByRole('button', { name: 'Delete collection' })).toBeNull();
  });

  it('does not select the workspace index with Enter or Space', () => {
    renderWithProvider(
      <CollectionPicker
        {...defaultProps}
        collections={[workspaceIndexCollection, ...mockCollections]}
      />
    );

    const listbox = screen.getByRole('listbox');
    listbox.focus();

    fireEvent.keyDown(listbox, { key: 'Enter' });
    fireEvent.keyDown(listbox, { key: ' ' });

    expect(defaultProps.onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(defaultProps.onSelect).toHaveBeenCalledWith('1');
  });
});

describe('getCollectionPickerProtection', () => {
  it('provides a disabled reason for non-selectable collections', () => {
    const baseCollection = mockCollections[0];
    if (!baseCollection) {
      throw new Error('Expected at least one mock collection');
    }

    expect(
      getCollectionPickerProtection({
        ...baseCollection,
        canNormalSearchSelect: false,
      }).disabledReason
    ).toBe('Selection is disabled for this collection');
  });

  it('preserves explicit collection permissions and disabled reasons', () => {
    const baseCollection = mockCollections[0];
    if (!baseCollection) {
      throw new Error('Expected at least one mock collection');
    }

    expect(
      getCollectionPickerProtection({
        ...baseCollection,
        canDelete: false,
        canEdit: false,
        canNormalSearchSelect: false,
        disabledReason: 'Temporarily unavailable',
      })
    ).toEqual(
      expect.objectContaining({
        badgeLabel: null,
        canDelete: false,
        canEdit: false,
        disabledReason: 'Temporarily unavailable',
        isDisabled: true,
        isWorkspaceIndex: false,
      })
    );
  });
});

describe('collection color helpers', () => {
  it('formats provider labels and falls back to Local for provider-less model keys', () => {
    expect(extractProviderId('anthropic::embedding-model')).toBe('anthropic');
    expect(extractProviderId('bare-model')).toBeNull();
    expect(formatProviderLabel('anthropic::embedding-model')).toBe('Anthropic');
    expect(formatProviderLabel('bare-model')).toBe('Local');
  });

  it('returns deterministic light and dark theme colors', () => {
    expect(getCollectionColor('', 'light')).toEqual({
      background: 'hsl(0, 55%, 97%)',
      primary: 'hsl(0, 55%, 40%)',
    });
    expect(getCollectionColor('', 'dark')).toEqual({
      background: 'hsl(0, 55%, 15%)',
      primary: 'hsl(0, 55%, 55%)',
    });
  });
});

describe('mutationBlockedReason (PR #2381 review)', () => {
  /**
   * Deleting the collection an import is CURRENTLY writing into orphans every
   * chunk the run writes after the delete — `file_chunks.embedding_set_id`
   * carries no foreign key. The controls must therefore refuse, and refuse
   * VISIBLY: hiding them would read as "this collection was never editable".
   */
  const BLOCKED = 'An import is writing into this collection — finish or cancel it first';

  function renderWithBlocked(blockedId: string | null) {
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    render(
      <TooltipProvider>
        <CollectionPicker
          collections={mockCollections.map((collection) =>
            collection.id === blockedId
              ? { ...collection, mutationBlockedReason: BLOCKED }
              : collection
          )}
          onCreate={vi.fn()}
          onDelete={onDelete}
          onEdit={onEdit}
          onSelect={vi.fn()}
          selectedId={null}
        />
      </TooltipProvider>
    );
    return { onDelete, onEdit };
  }

  it('disables delete and edit for the blocked collection without hiding them', () => {
    const first = mockCollections[0];
    if (!first) {
      throw new Error('fixture missing');
    }
    const { onDelete, onEdit } = renderWithBlocked(first.id);

    const del = screen.getByRole('button', { name: new RegExp(`Delete collection.*${BLOCKED}`) });
    const edit = screen.getByRole('button', { name: new RegExp(`Edit collection.*${BLOCKED}`) });
    expect(del).toBeDisabled();
    expect(edit).toBeDisabled();

    fireEvent.click(del);
    fireEvent.click(edit);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('leaves other collections fully mutable', () => {
    const [first, second] = mockCollections;
    if (!(first && second)) {
      throw new Error('fixture missing');
    }
    const { onDelete } = renderWithBlocked(first.id);

    const enabled = screen.getByRole('button', { name: 'Delete collection' });
    expect(enabled).toBeEnabled();
    fireEvent.click(enabled);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('re-enables the controls once nothing is blocked (run settled)', () => {
    const { onDelete } = renderWithBlocked(null);

    const buttons = screen.getAllByRole('button', { name: 'Delete collection' });
    expect(buttons.length).toBe(mockCollections.length);
    for (const button of buttons) {
      expect(button).toBeEnabled();
    }
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('getCollectionPickerProtection mutationBlockedReason', () => {
  it('surfaces the reason so the item can render it as the tooltip', () => {
    const first = mockCollections[0];
    if (!first) {
      throw new Error('fixture missing');
    }
    expect(
      getCollectionPickerProtection({ ...first, mutationBlockedReason: 'busy' })
        .mutationBlockedReason
    ).toBe('busy');
    expect(getCollectionPickerProtection(first).mutationBlockedReason).toBeNull();
  });
});
