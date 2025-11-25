/**
 * Tests for FilterBar component
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from '../collection-browser/filter-bar';
import type { CollectionBrowserFilters } from '../collection-browser/types';
import { DEFAULT_FILTERS } from '../collection-browser/types';

// Helper to create test filters
function createFilters(
  overrides: Partial<CollectionBrowserFilters> = {}
): CollectionBrowserFilters {
  return {
    ...DEFAULT_FILTERS,
    nodeTypes: new Set(DEFAULT_FILTERS.nodeTypes),
    ...overrides,
  };
}

describe('FilterBar', () => {
  describe('rendering', () => {
    it('renders search input', () => {
      render(<FilterBar filters={createFilters()} onFiltersChange={() => {}} />);

      expect(screen.getByTestId('filter-search-input')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/search collections/i)).toBeInTheDocument();
    });

    it('renders node type filter chips', () => {
      render(<FilterBar filters={createFilters()} onFiltersChange={() => {}} />);

      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('Collections')).toBeInTheDocument();
      expect(screen.getByText('Files')).toBeInTheDocument();
      expect(screen.getByText('Chunks')).toBeInTheDocument();
      expect(screen.getByText('Embeddings')).toBeInTheDocument();
    });

    it('renders embedding status dropdown', () => {
      render(<FilterBar filters={createFilters()} onFiltersChange={() => {}} />);

      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('renders expand/collapse buttons by default', () => {
      render(
        <FilterBar
          filters={createFilters()}
          onFiltersChange={() => {}}
          onExpandAll={() => {}}
          onCollapseAll={() => {}}
        />
      );

      expect(screen.getByLabelText('Expand all')).toBeInTheDocument();
      expect(screen.getByLabelText('Collapse all')).toBeInTheDocument();
    });

    it('hides expand/collapse buttons when showExpandControls is false', () => {
      render(
        <FilterBar
          filters={createFilters()}
          onFiltersChange={() => {}}
          showExpandControls={false}
        />
      );

      expect(screen.queryByLabelText('Expand all')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Collapse all')).not.toBeInTheDocument();
    });

    it('renders result count when provided', () => {
      render(
        <FilterBar
          filters={createFilters()}
          onFiltersChange={() => {}}
          resultCount={50}
          totalCount={100}
        />
      );

      expect(screen.getByText('50 of 100')).toBeInTheDocument();
    });

    it('renders total count when result equals total', () => {
      render(
        <FilterBar
          filters={createFilters()}
          onFiltersChange={() => {}}
          resultCount={100}
          totalCount={100}
        />
      );

      expect(screen.getByText('100 items')).toBeInTheDocument();
    });

    it('applies custom className', () => {
      const { container } = render(
        <FilterBar filters={createFilters()} onFiltersChange={() => {}} className="custom-class" />
      );

      expect(container.firstChild).toHaveClass('custom-class');
    });
  });

  describe('search functionality', () => {
    it('displays current search query', () => {
      render(
        <FilterBar
          filters={createFilters({ searchQuery: 'test query' })}
          onFiltersChange={() => {}}
        />
      );

      expect(screen.getByTestId('filter-search-input')).toHaveValue('test query');
    });

    it('calls onFiltersChange when search input changes', () => {
      const handleChange = vi.fn();
      render(<FilterBar filters={createFilters()} onFiltersChange={handleChange} />);

      fireEvent.change(screen.getByTestId('filter-search-input'), {
        target: { value: 'new search' },
      });

      expect(handleChange).toHaveBeenCalledWith(
        expect.objectContaining({ searchQuery: 'new search' })
      );
    });

    it('shows clear button when search has value', () => {
      render(
        <FilterBar filters={createFilters({ searchQuery: 'test' })} onFiltersChange={() => {}} />
      );

      expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
    });

    it('hides clear button when search is empty', () => {
      render(<FilterBar filters={createFilters({ searchQuery: '' })} onFiltersChange={() => {}} />);

      expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
    });

    it('clears search when clear button clicked', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({ searchQuery: 'test' })}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.click(screen.getByLabelText('Clear search'));

      expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ searchQuery: '' }));
    });
  });

  describe('node type filtering', () => {
    it('shows All chip as active when all types selected', () => {
      render(<FilterBar filters={createFilters()} onFiltersChange={() => {}} />);

      const allChip = screen.getByText('All').closest('button');
      expect(allChip).toHaveAttribute('aria-pressed', 'true');
    });

    it('shows individual chips as active based on filter state', () => {
      render(
        <FilterBar
          filters={createFilters({
            nodeTypes: new Set(['file', 'chunk']),
          })}
          onFiltersChange={() => {}}
        />
      );

      expect(screen.getByText('Files').closest('button')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Chunks').closest('button')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Collections').closest('button')).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      expect(screen.getByText('Embeddings').closest('button')).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });

    it('toggles node type when chip clicked', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({
            nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
          })}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.click(screen.getByText('Files'));

      expect(handleChange).toHaveBeenCalled();
      const newFilters = handleChange.mock.calls[0]?.[0] as CollectionBrowserFilters;
      expect(newFilters.nodeTypes.has('file')).toBe(false);
    });

    it('does not allow deselecting last node type', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({
            nodeTypes: new Set(['file']),
          })}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.click(screen.getByText('Files'));

      // Should not call change since it's the last selected type
      expect(handleChange).not.toHaveBeenCalled();
    });

    it('selects all node types when All chip clicked', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({
            nodeTypes: new Set(['file']),
          })}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.click(screen.getByText('All'));

      expect(handleChange).toHaveBeenCalled();
      const newFilters = handleChange.mock.calls[0]?.[0] as CollectionBrowserFilters;
      expect(newFilters.nodeTypes.size).toBe(4);
    });
  });

  describe('embedding status filtering', () => {
    it('displays current embedding status', () => {
      render(
        <FilterBar
          filters={createFilters({ embeddingStatus: 'complete' })}
          onFiltersChange={() => {}}
        />
      );

      // The select trigger should show the selected value
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('calls onFiltersChange when status changes', async () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({ embeddingStatus: 'all' })}
          onFiltersChange={handleChange}
        />
      );

      // Open the dropdown
      fireEvent.click(screen.getByRole('combobox'));

      // Select a new status (using role listbox to find options)
      const listbox = screen.getByRole('listbox');
      const completeOption = within(listbox).getByText('Complete');
      fireEvent.click(completeOption);

      expect(handleChange).toHaveBeenCalledWith(
        expect.objectContaining({ embeddingStatus: 'complete' })
      );
    });
  });

  describe('expand/collapse controls', () => {
    it('calls onExpandAll when expand button clicked', () => {
      const handleExpand = vi.fn();
      render(
        <FilterBar
          filters={createFilters()}
          onFiltersChange={() => {}}
          onExpandAll={handleExpand}
          onCollapseAll={() => {}}
        />
      );

      fireEvent.click(screen.getByLabelText('Expand all'));

      expect(handleExpand).toHaveBeenCalledTimes(1);
    });

    it('calls onCollapseAll when collapse button clicked', () => {
      const handleCollapse = vi.fn();
      render(
        <FilterBar
          filters={createFilters()}
          onFiltersChange={() => {}}
          onExpandAll={() => {}}
          onCollapseAll={handleCollapse}
        />
      );

      fireEvent.click(screen.getByLabelText('Collapse all'));

      expect(handleCollapse).toHaveBeenCalledTimes(1);
    });
  });
});
