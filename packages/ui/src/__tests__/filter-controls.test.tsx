/**
 * Tests for the shared FilterControls component.
 *
 * These cover behavior plus the callback-stability guarantee: changing
 * `filters` between renders must NOT churn the click/change handler
 * identities, otherwise the memoized FilterChip re-renders on every
 * keystroke and the perf benefit of memoization is lost.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterControls } from '../collection-browser/filter-controls';
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

describe('FilterControls', () => {
  it('typing fires onFiltersChange with the new searchQuery', () => {
    const handle = vi.fn();
    render(<FilterControls filters={createFilters()} onFiltersChange={handle} />);

    fireEvent.change(screen.getByTestId('filter-search-input'), {
      target: { value: 'abc' },
    });

    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ searchQuery: 'abc' }));
  });

  it('toggling Embedded fires onFiltersChange with the flipped status', () => {
    const handle = vi.fn();
    render(
      <FilterControls
        filters={createFilters({ embeddingStatus: 'all' })}
        onFiltersChange={handle}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Embedded' }));

    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ embeddingStatus: 'complete' }));
  });

  it('callbacks always see the latest filters snapshot (no stale closure)', () => {
    const handle = vi.fn();
    const { rerender } = render(
      <FilterControls filters={createFilters({ searchQuery: 'first' })} onFiltersChange={handle} />
    );

    // Parent updates filters (e.g. embeddingStatus toggled elsewhere) without
    // routing through this component's handlers.
    rerender(
      <FilterControls
        filters={createFilters({ searchQuery: 'first', embeddingStatus: 'complete' })}
        onFiltersChange={handle}
      />
    );

    // Now type — the callback must merge into the LATEST filters, not the
    // initial render's snapshot.
    fireEvent.change(screen.getByTestId('filter-search-input'), {
      target: { value: 'second' },
    });

    expect(handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchQuery: 'second', embeddingStatus: 'complete' })
    );
  });

  it('preserves the chip across keystroke-driven re-renders (memoized via stable callbacks)', () => {
    const handle = vi.fn();

    const { rerender } = render(
      <FilterControls filters={createFilters({ searchQuery: '' })} onFiltersChange={handle} />
    );
    const chip1 = screen.getByRole('button', { name: 'Embedded' });

    rerender(
      <FilterControls filters={createFilters({ searchQuery: 'a' })} onFiltersChange={handle} />
    );
    const chip2 = screen.getByRole('button', { name: 'Embedded' });

    rerender(
      <FilterControls filters={createFilters({ searchQuery: 'ab' })} onFiltersChange={handle} />
    );
    const chip3 = screen.getByRole('button', { name: 'Embedded' });

    // Stable onClick + React.memo means FilterChip does not unmount across
    // keystrokes — the identical DOM node persists.
    expect(chip1).toBe(chip2);
    expect(chip2).toBe(chip3);

    // And clicking still toggles correctly against the latest filters.
    fireEvent.click(chip3);
    expect(handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ embeddingStatus: 'complete', searchQuery: 'ab' })
    );
  });
});
