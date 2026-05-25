import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectionBrowserToolbar } from '../collection-browser/collection-browser-toolbar';
import type { CollectionNodeType } from '../collection-browser/types';

describe('CollectionBrowserToolbar', () => {
  it('renders grid controls as icon buttons', () => {
    render(
      <CollectionBrowserToolbar
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onGroupByChange={vi.fn()}
        onMultiSelectToggle={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
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

  it('uses aria-pressed for active multi-select', () => {
    render(
      <CollectionBrowserToolbar
        filters={{
          embeddingStatus: 'all',
          nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
          searchMatchesOnly: false,
          searchQuery: '',
        }}
        multiSelectEnabled
        onFiltersChange={vi.fn()}
        onMultiSelectToggle={vi.fn()}
      />
    );

    const multiSelectToggle = screen.getByRole('button', { name: 'Toggle multi-select' });
    expect(multiSelectToggle).toHaveAttribute('aria-pressed', 'true');
    expect(multiSelectToggle).toHaveClass('bg-accent');
  });

  it('marks filter popover trigger active when node type membership is reduced', () => {
    render(
      <CollectionBrowserToolbar
        filters={{
          embeddingStatus: 'all',
          nodeTypes: new Set<CollectionNodeType>(['file', 'chunk', 'embedding']),
          searchMatchesOnly: false,
          searchQuery: '',
        }}
        onFiltersChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Filters (active)' })).toHaveClass('bg-accent');
  });

  it('marks filter popover trigger active when node type membership differs at same size', () => {
    // Exercises the `.some()` membership-diff branch of hasActiveFilters
    // independently of the `.size` check: same count as the default set
    // (4 entries) but with `unknown` swapped in for `collection`.
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
        onFiltersChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Filters (active)' })).toHaveClass('bg-accent');
  });

  it('calls multi-select toggle handler with the next state', () => {
    const onMultiSelectToggle = vi.fn();

    render(
      <CollectionBrowserToolbar
        multiSelectEnabled={false}
        onMultiSelectToggle={onMultiSelectToggle}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle multi-select' }));

    expect(onMultiSelectToggle).toHaveBeenCalledWith(true);
  });

  it('highlights group-by when grouping is active', () => {
    render(<CollectionBrowserToolbar groupBy="status" onGroupByChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Group by' })).toHaveClass('bg-accent');
  });

  describe('accessibility polish (BST-519)', () => {
    it('hides decorative icons from assistive tech (buttons have their own labels)', () => {
      const { container } = render(
        <CollectionBrowserToolbar
          filters={{
            embeddingStatus: 'all',
            nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
            searchMatchesOnly: false,
            searchQuery: '',
          }}
          groupBy="none"
          onCollapseAll={vi.fn()}
          onExpandAll={vi.fn()}
          onFiltersChange={vi.fn()}
          onGroupByChange={vi.fn()}
          onMultiSelectToggle={vi.fn()}
        />
      );

      // lucide-react renamed Filter -> Funnel in recent versions, so the rendered
      // class is `lucide-funnel`. Same for the other icon imports.
      for (const className of [
        '.lucide-funnel',
        '.lucide-chevrons-up-down',
        '.lucide-chevrons-down-up',
        '.lucide-list-checks',
        '.lucide-group',
      ]) {
        const icon = container.querySelector(className);
        expect(icon, `${className} should be aria-hidden`).toHaveAttribute('aria-hidden', 'true');
      }
    });
  });
});
