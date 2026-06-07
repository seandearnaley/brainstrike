import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import { CollectionPicker } from '../collection-picker';
import type { CollectionPickerCollection } from '../types';

// Mock useTheme
vi.mock('../../theme-provider', () => ({
  useTheme: () => ({
    theme: 'light',
    setTheme: vi.fn(),
  }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    id: '1',
    modelKey: 'openai::text-embedding-3-small',
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
    distance: 'cosine',
    createdAt: new Date().toISOString(),
    name: 'Collection 1',
    description: 'Description 1',
    tags: null,
    category: null,
    fileCount: 10,
    chunkCount: 100,
    embeddingCount: 100,
  },
  {
    id: '2',
    modelKey: 'local::Xenova/bge-m3',
    modelId: 'bge-m3',
    dimensions: 1024,
    distance: 'cosine',
    createdAt: new Date().toISOString(),
    name: null,
    description: null,
    tags: null,
    category: null,
    fileCount: 5,
    chunkCount: 50,
    embeddingCount: 50,
  },
];

const workspaceIndexCollection: CollectionPickerCollection = {
  id: 'workspace-index',
  modelKey: 'openai::text-embedding-3-small',
  modelId: 'text-embedding-3-small',
  dimensions: 1536,
  distance: 'cosine',
  createdAt: new Date().toISOString(),
  name: 'Workspace Index',
  description: 'System-managed workspace index for assistant retrieval.',
  tags: null,
  category: null,
  fileCount: 42,
  chunkCount: 420,
  embeddingCount: 300,
  systemRole: 'workspace-index',
};

describe('CollectionPicker', () => {
  const defaultProps = {
    collections: mockCollections,
    selectedId: null,
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCreate: vi.fn(),
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
