/**
 * Tests for the responsive filter controls inside CollectionBrowserToolbar.
 *
 * These cover the relocation of the Quick Filters (filter input + Embedded
 * toggle) into the toolbar itself, plus the container-query-driven collapse
 * behavior used when the parent panel is narrow.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectionBrowserToolbar } from '../collection-browser/collection-browser-toolbar';
import type { CollectionBrowserFilters } from '../collection-browser/types';
import { DEFAULT_FILTERS } from '../collection-browser/types';

function createFilters(
  overrides: Partial<CollectionBrowserFilters> = {}
): CollectionBrowserFilters {
  return {
    ...DEFAULT_FILTERS,
    nodeTypes: new Set(DEFAULT_FILTERS.nodeTypes),
    ...overrides,
  };
}

describe('CollectionBrowserToolbar - inline filter controls', () => {
  it('does not render the legacy "Collection" label', () => {
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />);

    expect(screen.queryByText(/^Collection$/)).not.toBeInTheDocument();
  });

  it('renders an inline filter-by-name input when filters + onFiltersChange are provided', () => {
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />);

    const input = screen.getByTestId('filter-search-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/filter by name/i));
  });

  it('renders the Embedded toggle chip in the toolbar', () => {
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Embedded' })).toBeInTheDocument();
  });

  it('does NOT render the inline filter UI when filters/onFiltersChange are absent', () => {
    render(<CollectionBrowserToolbar onExpandAll={vi.fn()} />);

    expect(screen.queryByTestId('filter-search-input')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Embedded' })).not.toBeInTheDocument();
  });

  it('marks the toolbar as a Tailwind container so child controls can react to its inline width', () => {
    const { container } = render(
      <CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />
    );

    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/@container\/cb-toolbar/);
  });

  it('hides the inline filter input on narrow widths via container-query utilities', () => {
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />);

    const inputContainer = screen.getByTestId('filter-search-input-container');
    // hidden by default; revealed at the configured breakpoint via @container queries
    expect(inputContainer.className).toMatch(/hidden/);
    expect(inputContainer.className).toMatch(/@\[\d+px\]\/cb-toolbar:flex/);
  });

  it('hides the Embedded chip on narrow widths via container-query utilities', () => {
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />);

    const chip = screen.getByRole('button', { name: 'Embedded' });
    expect(chip.className).toMatch(/hidden/);
    expect(chip.className).toMatch(/@\[\d+px\]\/cb-toolbar:inline-flex/);
  });
});

describe('CollectionBrowserToolbar - filter input behavior', () => {
  it('reflects the controlled searchQuery value', () => {
    render(
      <CollectionBrowserToolbar
        filters={createFilters({ searchQuery: 'hello' })}
        onFiltersChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('filter-search-input')).toHaveValue('hello');
  });

  it('calls onFiltersChange when the user types', () => {
    const handleChange = vi.fn();
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={handleChange} />);

    fireEvent.change(screen.getByTestId('filter-search-input'), {
      target: { value: 'foo' },
    });

    expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ searchQuery: 'foo' }));
  });

  it('shows a Clear button only when the query is non-empty', () => {
    const { rerender } = render(
      <CollectionBrowserToolbar
        filters={createFilters({ searchQuery: '' })}
        onFiltersChange={vi.fn()}
      />
    );

    expect(screen.queryByLabelText(/clear search/i)).not.toBeInTheDocument();

    rerender(
      <CollectionBrowserToolbar
        filters={createFilters({ searchQuery: 'foo' })}
        onFiltersChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/clear search/i)).toBeInTheDocument();
  });

  it('clears the query when the Clear button is clicked', () => {
    const handleChange = vi.fn();
    render(
      <CollectionBrowserToolbar
        filters={createFilters({ searchQuery: 'foo' })}
        onFiltersChange={handleChange}
      />
    );

    fireEvent.click(screen.getByLabelText(/clear search/i));

    expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ searchQuery: '' }));
  });
});

describe('CollectionBrowserToolbar - Embedded toggle behavior', () => {
  it('toggles embedding status from "all" to "complete"', () => {
    const handleChange = vi.fn();
    render(
      <CollectionBrowserToolbar
        filters={createFilters({ embeddingStatus: 'all' })}
        onFiltersChange={handleChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Embedded' }));

    expect(handleChange).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingStatus: 'complete' })
    );
  });

  it('reflects the active state via aria-pressed', () => {
    const { rerender } = render(
      <CollectionBrowserToolbar
        filters={createFilters({ embeddingStatus: 'all' })}
        onFiltersChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Embedded' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    rerender(
      <CollectionBrowserToolbar
        filters={createFilters({ embeddingStatus: 'complete' })}
        onFiltersChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Embedded' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});

describe('CollectionBrowserToolbar - narrow-width filter popover', () => {
  it('exposes a Filter popover trigger that is hidden at wide widths and shown at narrow', () => {
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />);

    const popoverTrigger = screen.getByRole('button', { name: /filters/i });
    expect(popoverTrigger).toBeInTheDocument();
    // shown at narrow, hidden at wide via @container
    expect(popoverTrigger.className).toMatch(/@\[\d+px\]\/cb-toolbar:hidden/);
  });

  it('shows an active-state dot on the popover trigger when filters are active', () => {
    render(
      <CollectionBrowserToolbar
        filters={createFilters({ searchQuery: 'foo' })}
        onFiltersChange={vi.fn()}
      />
    );

    const popoverTrigger = screen.getByRole('button', { name: /filters \(active\)/i });
    expect(popoverTrigger).toBeInTheDocument();
  });

  it('keeps the filter popover available until the inline Embedded chip appears (no functional gap)', () => {
    render(<CollectionBrowserToolbar filters={createFilters()} onFiltersChange={vi.fn()} />);

    const chip = screen.getByRole('button', { name: 'Embedded' });
    const popoverTrigger = screen.getByRole('button', { name: /filters/i });

    const chipMatch = chip.className.match(/@\[(\d+)px\]\/cb-toolbar:inline-flex/);
    const popoverMatch = popoverTrigger.className.match(/@\[(\d+)px\]\/cb-toolbar:hidden/);

    expect(chipMatch).not.toBeNull();
    expect(popoverMatch).not.toBeNull();

    const chipBreakpoint = Number(chipMatch?.[1]);
    const popoverBreakpoint = Number(popoverMatch?.[1]);

    // The popover must NOT disappear before the inline chip appears, otherwise
    // there's a width range where the Embedded toggle is unreachable.
    expect(popoverBreakpoint).toBeGreaterThanOrEqual(chipBreakpoint);
  });
});
