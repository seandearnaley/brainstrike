import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectionBrowserToolbar } from '../collection-browser/collection-browser-toolbar';
import type { CollectionNodeType } from '../collection-browser/types';

describe('CollectionBrowserToolbar', () => {
  it('renders grid controls as icon buttons at the collection level', () => {
    render(
      <CollectionBrowserToolbar
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onFilterVisibleChange={vi.fn()}
        onGroupByChange={vi.fn()}
        onMultiSelectToggle={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle filters' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle multi-select' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group by' })).toBeInTheDocument();
  });

  it('calls expand and collapse handlers', () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    render(<CollectionBrowserToolbar onCollapseAll={onCollapseAll} onExpandAll={onExpandAll} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(onExpandAll).toHaveBeenCalled();
    expect(onCollapseAll).toHaveBeenCalled();
  });

  it('uses aria-pressed for active filters and multi-select', () => {
    render(
      <CollectionBrowserToolbar
        filters={{
          embeddingStatus: 'all',
          nodeTypes: new Set(['collection', 'file', 'chunk']),
          searchMatchesOnly: false,
          searchQuery: '',
        }}
        isFilterVisible={false}
        multiSelectEnabled
        onFilterVisibleChange={vi.fn()}
        onMultiSelectToggle={vi.fn()}
      />
    );

    const filterToggle = screen.getByRole('button', { name: 'Toggle filters (active)' });
    expect(filterToggle).toHaveAttribute('aria-pressed', 'false');
    expect(filterToggle).toHaveClass('bg-accent');

    const multiSelectToggle = screen.getByRole('button', { name: 'Toggle multi-select' });
    expect(multiSelectToggle).toHaveAttribute('aria-pressed', 'true');
    expect(multiSelectToggle).toHaveClass('bg-accent');
  });

  it('marks filters active when node type membership changes without changing size', () => {
    render(
      <CollectionBrowserToolbar
        filters={{
          embeddingStatus: 'all',
          nodeTypes: new Set<CollectionNodeType>([
            'file',
            'chunk',
            'embedding',
            'unknown' as CollectionNodeType,
          ]),
          searchMatchesOnly: false,
          searchQuery: '',
        }}
        isFilterVisible={false}
        onFilterVisibleChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Toggle filters (active)' })).toHaveClass(
      'bg-accent'
    );
  });

  it('calls toolbar toggle handlers with the next state', () => {
    const onFilterVisibleChange = vi.fn();
    const onMultiSelectToggle = vi.fn();

    render(
      <CollectionBrowserToolbar
        isFilterVisible={false}
        multiSelectEnabled={false}
        onFilterVisibleChange={onFilterVisibleChange}
        onMultiSelectToggle={onMultiSelectToggle}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle multi-select' }));

    expect(onFilterVisibleChange).toHaveBeenCalledWith(true);
    expect(onMultiSelectToggle).toHaveBeenCalledWith(true);
  });

  it('highlights group-by when grouping is active', () => {
    render(<CollectionBrowserToolbar groupBy="status" onGroupByChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Group by' })).toHaveClass('bg-accent');
  });
});
