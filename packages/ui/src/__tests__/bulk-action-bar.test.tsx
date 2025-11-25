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
      id: 'embed',
      label: 'Embed',
      onAction: vi.fn(),
      applicableTypes: ['file', 'chunk'],
    },
    {
      id: 'delete',
      label: 'Delete',
      onAction: vi.fn(),
      destructive: true,
    },
  ];

  it('renders nothing when no items are selected', () => {
    const { container } = render(
      <BulkActionBar
        selectedIds={new Set()}
        nodeTypes={new Map()}
        actions={mockActions}
        onClearSelection={mockClearSelection}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders selection count and summary', () => {
    render(
      <BulkActionBar
        selectedIds={new Set(['file-1', 'file-2', 'chunk-1'])}
        nodeTypes={mockNodeTypes}
        actions={mockActions}
        onClearSelection={mockClearSelection}
      />
    );

    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(screen.getByText('(2 files, 1 chunk)')).toBeInTheDocument();
  });

  it('renders action buttons', () => {
    render(
      <BulkActionBar
        selectedIds={new Set(['file-1'])}
        nodeTypes={mockNodeTypes}
        actions={mockActions}
        onClearSelection={mockClearSelection}
      />
    );

    expect(screen.getByRole('button', { name: 'Embed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('calls action handler when action button is clicked', () => {
    const selectedIds = new Set(['file-1', 'file-2']);

    render(
      <BulkActionBar
        selectedIds={selectedIds}
        nodeTypes={mockNodeTypes}
        actions={mockActions}
        onClearSelection={mockClearSelection}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    const embedAction = mockActions[0];
    expect(embedAction?.onAction).toHaveBeenCalledWith(selectedIds, mockNodeTypes);
  });

  it('calls onClearSelection when clear button is clicked', () => {
    render(
      <BulkActionBar
        selectedIds={new Set(['file-1'])}
        nodeTypes={mockNodeTypes}
        actions={mockActions}
        onClearSelection={mockClearSelection}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(mockClearSelection).toHaveBeenCalled();
  });

  it('filters actions based on applicable types', () => {
    const actionsWithTypeFilter: BulkAction[] = [
      {
        id: 'embed',
        label: 'Embed',
        onAction: vi.fn(),
        applicableTypes: ['file'],
      },
      {
        id: 'chunk-only',
        label: 'Chunk Only',
        onAction: vi.fn(),
        applicableTypes: ['chunk'],
      },
    ];

    // Select only files - should only show Embed
    const { rerender } = render(
      <BulkActionBar
        selectedIds={new Set(['file-1'])}
        nodeTypes={mockNodeTypes}
        actions={actionsWithTypeFilter}
        onClearSelection={mockClearSelection}
      />
    );

    expect(screen.getByRole('button', { name: 'Embed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chunk Only' })).not.toBeInTheDocument();

    // Select chunks - should show Chunk Only
    rerender(
      <BulkActionBar
        selectedIds={new Set(['chunk-1'])}
        nodeTypes={mockNodeTypes}
        actions={actionsWithTypeFilter}
        onClearSelection={mockClearSelection}
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
        selectedIds={new Set(['file-1'])}
        nodeTypes={mockNodeTypes}
        actions={actionsNoFilter}
        onClearSelection={mockClearSelection}
      />
    );

    expect(screen.getByRole('button', { name: 'Export All' })).toBeInTheDocument();
  });

  it('renders disabled actions correctly', () => {
    const actionsWithDisabled: BulkAction[] = [
      {
        id: 'embed',
        label: 'Embed',
        onAction: vi.fn(),
        disabled: true,
        disabledReason: 'No model configured',
      },
    ];

    render(
      <BulkActionBar
        selectedIds={new Set(['file-1'])}
        nodeTypes={mockNodeTypes}
        actions={actionsWithDisabled}
        onClearSelection={mockClearSelection}
      />
    );

    const button = screen.getByRole('button', { name: 'Embed' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No model configured');
  });
});
