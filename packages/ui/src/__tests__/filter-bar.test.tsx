/**
 * Tests for FilterBar component
 *
 * The FilterBar provides a streamlined filtering interface with:
 * - Text search input
 * - Embedded status toggle
 */
import { fireEvent, render, screen } from '@testing-library/react';
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
      render(
        <FilterBar
          filters={createFilters()}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      expect(screen.getByTestId('filter-search-input')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/filter by name/i)).toBeInTheDocument();
    });

    it('renders embedded status toggle', () => {
      render(
        <FilterBar
          filters={createFilters()}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      expect(screen.getByText('Embedded')).toBeInTheDocument();
    });

    it('applies custom className', () => {
      const { container } = render(
        <FilterBar
          className="custom-class"
          filters={createFilters()}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      expect(container.firstChild).toHaveClass('custom-class');
    });

    it('toggles visibility when header is clicked', () => {
      const onExpandedChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters()}
          isExpanded={false}
          onExpandedChange={onExpandedChange}
          onFiltersChange={() => {}}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /quick filters/i }));
      expect(onExpandedChange).toHaveBeenCalledWith(true);
    });
  });

  describe('search functionality', () => {
    it('displays current search query', () => {
      render(
        <FilterBar
          filters={createFilters({ searchQuery: 'test query' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      expect(screen.getByTestId('filter-search-input')).toHaveValue('test query');
    });

    it('calls onFiltersChange when search input changes', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters()}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.change(screen.getByTestId('filter-search-input'), {
        target: { value: 'new search' },
      });

      expect(handleChange).toHaveBeenCalledWith(
        expect.objectContaining({ searchQuery: 'new search' })
      );
    });

    it('shows clear button when search has value', () => {
      render(
        <FilterBar
          filters={createFilters({ searchQuery: 'test' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
    });

    it('hides clear button when search is empty', () => {
      render(
        <FilterBar
          filters={createFilters({ searchQuery: '' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
    });

    it('clears search when clear button clicked', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({ searchQuery: 'test' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.click(screen.getByLabelText('Clear search'));

      expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ searchQuery: '' }));
    });
  });

  describe('embedded status toggle', () => {
    it('shows toggle as inactive when status is "all"', () => {
      render(
        <FilterBar
          filters={createFilters({ embeddingStatus: 'all' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      const embeddedChip = screen.getByText('Embedded').closest('button');
      expect(embeddedChip).toHaveAttribute('aria-pressed', 'false');
    });

    it('shows toggle as active when status is "complete"', () => {
      render(
        <FilterBar
          filters={createFilters({ embeddingStatus: 'complete' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={() => {}}
        />
      );

      const embeddedChip = screen.getByText('Embedded').closest('button');
      expect(embeddedChip).toHaveAttribute('aria-pressed', 'true');
    });

    it('toggles from "all" to "complete" when clicked', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({ embeddingStatus: 'all' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.click(screen.getByText('Embedded'));

      expect(handleChange).toHaveBeenCalledWith(
        expect.objectContaining({ embeddingStatus: 'complete' })
      );
    });

    it('toggles from "complete" to "all" when clicked', () => {
      const handleChange = vi.fn();
      render(
        <FilterBar
          filters={createFilters({ embeddingStatus: 'complete' })}
          isExpanded={true}
          onExpandedChange={() => {}}
          onFiltersChange={handleChange}
        />
      );

      fireEvent.click(screen.getByText('Embedded'));

      expect(handleChange).toHaveBeenCalledWith(
        expect.objectContaining({ embeddingStatus: 'all' })
      );
    });
  });
});
