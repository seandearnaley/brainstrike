/**
 * BulkActionBar Component Tests
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkAction } from '../collection-browser/bulk-action-bar';
import { BulkActionBar } from '../collection-browser/bulk-action-bar';
import type { CollectionNodeType } from '../collection-browser/types';

describe('BulkActionBar', () => {
  afterEach(() => {
    cleanup();
  });

  const mockNodeTypes = new Map<string, CollectionNodeType>([
    ['file-1', 'file'],
    ['file-2', 'file'],
    ['chunk-1', 'chunk'],
  ]);

  const mockClearSelection = vi.fn();

  const mockActions: BulkAction[] = [
    {
      applicableTypes: ['file', 'chunk'],
      id: 'embed',
      label: 'Embed',
      onAction: vi.fn(),
    },
    {
      destructive: true,
      id: 'delete',
      label: 'Delete',
      onAction: vi.fn(),
    },
  ];

  it('renders nothing when no items are selected', () => {
    const { container } = render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={new Map()}
        onClearSelection={mockClearSelection}
        selectedIds={new Set()}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders selection count and summary', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1', 'file-2', 'chunk-1'])}
      />
    );

    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(screen.getByText('(2 files, 1 chunk)')).toBeInTheDocument();
  });

  it('renders custom summary text and subtext when provided', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
        summarySubtext="Custom summary detail"
        summarySubtextTitle="Custom summary title"
        summaryText="1 file selected in Context Explorer"
      />
    );

    expect(screen.getByText('1 file selected in Context Explorer')).toBeInTheDocument();
    const summaryDetail = screen.getByText('(Custom summary detail)');
    expect(summaryDetail).toBeInTheDocument();
    expect(summaryDetail).toHaveAttribute('title', 'Custom summary title');
  });

  it('supports hiding summary subtext with null', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
        summarySubtext={null}
        summaryText="Selection summary only"
      />
    );

    expect(screen.getByText('Selection summary only')).toBeInTheDocument();
    expect(screen.queryByText('(1 file)')).not.toBeInTheDocument();
  });

  it('renders action buttons', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    expect(screen.getByRole('button', { name: 'Embed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('calls action handler when action button is clicked', () => {
    const selectedIds = new Set(['file-1', 'file-2']);

    render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={selectedIds}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    const embedAction = mockActions[0];
    expect(embedAction?.onAction).toHaveBeenCalledWith(selectedIds, mockNodeTypes);
  });

  it('calls onClearSelection when clear button is clicked', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(mockClearSelection).toHaveBeenCalled();
  });

  it('uses custom clear button label and aria label when provided', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        clearButtonAriaLabel="Clear context selection"
        clearButtonLabel="Clear Context Selection"
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    const clearButton = screen.getByRole('button', { name: 'Clear context selection' });
    expect(clearButton).toHaveTextContent('Clear Context Selection');
    fireEvent.click(clearButton);
    expect(mockClearSelection).toHaveBeenCalled();
  });

  it('filters actions based on applicable types', () => {
    const actionsWithTypeFilter: BulkAction[] = [
      {
        applicableTypes: ['file'],
        id: 'embed',
        label: 'Embed',
        onAction: vi.fn(),
      },
      {
        applicableTypes: ['chunk'],
        id: 'chunk-only',
        label: 'Chunk Only',
        onAction: vi.fn(),
      },
    ];

    // Select only files - should only show Embed
    const { rerender } = render(
      <BulkActionBar
        actions={actionsWithTypeFilter}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    expect(screen.getByRole('button', { name: 'Embed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chunk Only' })).not.toBeInTheDocument();

    // Select chunks - should show Chunk Only
    rerender(
      <BulkActionBar
        actions={actionsWithTypeFilter}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['chunk-1'])}
      />
    );

    expect(screen.queryByRole('button', { name: 'Embed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chunk Only' })).toBeInTheDocument();
  });

  it('shows all action types when no type filter specified', () => {
    const actionsNoFilter: BulkAction[] = [
      {
        id: 'export',
        label: 'Export All',
        onAction: vi.fn(),
        // No applicableTypes - should show for any selection
      },
    ];

    render(
      <BulkActionBar
        actions={actionsNoFilter}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    expect(screen.getByRole('button', { name: 'Export All' })).toBeInTheDocument();
  });

  it('renders action buttons with title attribute for discoverability', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    const embedButton = screen.getByRole('button', { name: 'Embed' });
    expect(embedButton).toHaveAttribute('title', 'Embed');
  });

  it('renders compact mode with action labels still present in DOM', () => {
    render(
      <BulkActionBar
        actions={mockActions}
        compact
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1', 'chunk-1'])}
      />
    );

    // Buttons should still be findable and functional
    expect(screen.getByText('Embed')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('uses compactLabel when compact mode is enabled', () => {
    const actionsWithCompactLabel: BulkAction[] = [
      {
        compactLabel: 'Remove',
        id: 'remove',
        label: 'Remove Selected from Project',
        onAction: vi.fn(),
      },
    ];

    render(
      <BulkActionBar
        actions={actionsWithCompactLabel}
        compact
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    // Should show compactLabel text, not full label
    expect(screen.getByText('Remove')).toBeInTheDocument();
    expect(screen.queryByText('Remove Selected from Project')).not.toBeInTheDocument();
    // Full label should be in title attribute for discoverability
    const button = screen.getByRole('button', { name: 'Remove' });
    expect(button).toHaveAttribute('title', 'Remove Selected from Project');
  });

  it('falls back to label when compactLabel is not provided in compact mode', () => {
    const actionsWithoutCompactLabel: BulkAction[] = [
      {
        id: 'export',
        label: 'Export',
        onAction: vi.fn(),
      },
    ];

    render(
      <BulkActionBar
        actions={actionsWithoutCompactLabel}
        compact
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    expect(screen.getByText('Export')).toBeInTheDocument();
  });

  it('renders disabled actions correctly', () => {
    const actionsWithDisabled: BulkAction[] = [
      {
        disabled: true,
        disabledReason: 'No model configured',
        id: 'embed',
        label: 'Embed',
        onAction: vi.fn(),
      },
    ];

    render(
      <BulkActionBar
        actions={actionsWithDisabled}
        nodeTypes={mockNodeTypes}
        onClearSelection={mockClearSelection}
        selectedIds={new Set(['file-1'])}
      />
    );

    const button = screen.getByRole('button', { name: 'Embed' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No model configured');
  });
});
