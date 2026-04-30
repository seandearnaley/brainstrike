/**
 * Tests for the shared FilterControls component.
 *
 * These cover behavior plus the callback-stability guarantee: changing
 * `filters` between renders must NOT churn the click handler identity,
 * otherwise the memoized FilterChip re-renders on every keystroke and
 * the perf benefit of memoization is lost.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionBrowserFilters, FilterChipProps } from '../collection-browser/types';
import { DEFAULT_FILTERS } from '../collection-browser/types';

// Module-level counter for the spied FilterChip render fn. We mock the chip
// (not FilterControls) so we can directly observe whether stable callbacks
// + React.memo actually skip the chip's render work — `chip1 === chip2` on
// DOM nodes alone wouldn't tell us that, since React preserves DOM nodes
// for any unmounted component regardless of memoization.
let chipRenderCount = 0;

vi.mock('../collection-browser/filter-chip', () => ({
  FilterChip: React.memo(function MockFilterChip({
    label,
    active,
    onClick,
    className,
  }: FilterChipProps) {
    chipRenderCount++;
    return (
      <button
        aria-label={label}
        aria-pressed={active}
        className={className}
        onClick={onClick}
        type="button"
      >
        {label}
      </button>
    );
  }),
}));

// Import AFTER the mock so FilterControls picks up the spy chip.
const { FilterControls } = await import('../collection-browser/filter-controls');

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

  it('does not re-render the memoized FilterChip when only searchQuery changes', () => {
    // This is the real memoization assertion: since the ref-pinned callbacks
    // keep handleToggleEmbedded's identity stable and isEmbeddedActive depends
    // only on filters.embeddingStatus, the chip's props are referentially
    // equal across keystrokes, and React.memo skips the render fn entirely.
    chipRenderCount = 0;
    const handle = vi.fn();

    const { rerender } = render(
      <FilterControls filters={createFilters({ searchQuery: '' })} onFiltersChange={handle} />
    );
    expect(chipRenderCount).toBe(1);

    rerender(
      <FilterControls filters={createFilters({ searchQuery: 'a' })} onFiltersChange={handle} />
    );
    rerender(
      <FilterControls filters={createFilters({ searchQuery: 'ab' })} onFiltersChange={handle} />
    );
    rerender(
      <FilterControls filters={createFilters({ searchQuery: 'abc' })} onFiltersChange={handle} />
    );

    // Three keystrokes after mount, but the chip never had to re-render.
    expect(chipRenderCount).toBe(1);
  });

  it('re-renders the FilterChip when embeddingStatus actually changes', () => {
    // Negative control: when the chip's own state (active prop) changes, it
    // SHOULD re-render. This protects against an over-aggressive memo bug
    // that makes the assertion above pass for the wrong reason.
    chipRenderCount = 0;
    const handle = vi.fn();

    const { rerender } = render(
      <FilterControls
        filters={createFilters({ embeddingStatus: 'all' })}
        onFiltersChange={handle}
      />
    );
    expect(chipRenderCount).toBe(1);

    rerender(
      <FilterControls
        filters={createFilters({ embeddingStatus: 'complete' })}
        onFiltersChange={handle}
      />
    );

    expect(chipRenderCount).toBe(2);
  });
});
