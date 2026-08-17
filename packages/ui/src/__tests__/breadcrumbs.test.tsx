/**
 * Breadcrumbs contract (BST-1269): WAI-ARIA breadcrumb structure
 * (nav[aria-label] > ol > li, aria-current="page" on the leaf), segment click
 * routing, and middle-collapse overflow into a menu trigger. Menu-open
 * interaction is exercised in real browsers (pane e2e), not jsdom — Radix
 * menus need real pointer events.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Breadcrumbs } from '../breadcrumbs';

const SEGMENTS = [
  { label: 'src', path: '/repo/src' },
  { label: 'components', path: '/repo/src/components' },
  { label: 'button.tsx', path: '/repo/src/components/button.tsx' },
];

describe('Breadcrumbs', () => {
  it('renders WAI-ARIA breadcrumb structure with aria-current on the leaf', () => {
    render(<Breadcrumbs segments={SEGMENTS} />);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const list = nav.querySelector('ol');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('li')).toHaveLength(3);

    const leaf = screen.getByText('button.tsx');
    expect(leaf).toHaveAttribute('aria-current', 'page');
    expect(leaf.closest('button')).toBeNull();
  });

  it('routes non-leaf segment clicks to onSegmentClick with the segment path', () => {
    const onSegmentClick = vi.fn();
    render(<Breadcrumbs onSegmentClick={onSegmentClick} segments={SEGMENTS} />);

    fireEvent.click(screen.getByRole('button', { name: 'components' }));
    expect(onSegmentClick).toHaveBeenCalledExactlyOnceWith('/repo/src/components');
  });

  it('middle-collapses long paths into a menu trigger, keeping first and tail', () => {
    const longSegments = [
      { label: 'repo', path: '/repo' },
      { label: 'packages', path: '/repo/packages' },
      { label: 'ui', path: '/repo/packages/ui' },
      { label: 'src', path: '/repo/packages/ui/src' },
      { label: 'tree-table', path: '/repo/packages/ui/src/tree-table' },
      { label: 'types.ts', path: '/repo/packages/ui/src/tree-table/types.ts' },
    ];
    render(<Breadcrumbs maxVisibleSegments={4} onSegmentClick={vi.fn()} segments={longSegments} />);

    // First and the tail stay visible; the middle collapses.
    expect(screen.getByRole('button', { name: 'repo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tree-table' })).toBeInTheDocument();
    expect(screen.getByText('types.ts')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('packages')).not.toBeInTheDocument();
    expect(screen.queryByText('ui')).not.toBeInTheDocument();

    const overflowTrigger = screen.getByRole('button', { name: 'Show hidden path segments' });
    expect(overflowTrigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('display-only mode renders NO interactive overflow trigger', () => {
    const longSegments = [
      { label: 'repo', path: '/repo' },
      { label: 'packages', path: '/repo/packages' },
      { label: 'ui', path: '/repo/packages/ui' },
      { label: 'src', path: '/repo/packages/ui/src' },
      { label: 'tree-table', path: '/repo/packages/ui/src/tree-table' },
      { label: 'types.ts', path: '/repo/packages/ui/src/tree-table/types.ts' },
    ];
    render(<Breadcrumbs maxVisibleSegments={4} segments={longSegments} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  describe('popover mode (BST-1319)', () => {
    it('every segment INCLUDING the leaf is a trigger; content renders on click', () => {
      const renderSegmentPopover = vi.fn(
        (segment: { label: string; path: string }, _close: () => void) => (
          <div data-testid="segment-popover">{segment.path}</div>
        )
      );
      render(<Breadcrumbs renderSegmentPopover={renderSegmentPopover} segments={SEGMENTS} />);

      // The leaf keeps its aria-current identity but becomes a trigger — its
      // popover lists sibling FILES, the primary "change destination" case.
      const leaf = screen.getByRole('button', { name: 'button.tsx' });
      expect(leaf).toHaveAttribute('aria-current', 'page');

      fireEvent.click(screen.getByRole('button', { name: 'components' }));
      expect(screen.getByTestId('segment-popover')).toHaveTextContent('/repo/src/components');
    });

    it('the close callback dismisses the popover', () => {
      render(
        <Breadcrumbs
          renderSegmentPopover={(_segment, close) => (
            <button data-testid="pick" onClick={close} type="button">
              pick
            </button>
          )}
          segments={SEGMENTS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'src' }));
      expect(screen.getByTestId('pick')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('pick'));
      expect(screen.queryByTestId('pick')).not.toBeInTheDocument();
    });

    it('keeps the overflow ellipsis non-interactive (deep dirs are reachable by drilling)', () => {
      const longSegments = [
        { label: 'repo', path: '/repo' },
        { label: 'packages', path: '/repo/packages' },
        { label: 'ui', path: '/repo/packages/ui' },
        { label: 'src', path: '/repo/packages/ui/src' },
        { label: 'tree-table', path: '/repo/packages/ui/src/tree-table' },
        { label: 'types.ts', path: '/repo/packages/ui/src/tree-table/types.ts' },
      ];
      render(
        <Breadcrumbs
          maxVisibleSegments={4}
          renderSegmentPopover={() => null}
          segments={longSegments}
        />
      );
      expect(
        screen.queryByRole('button', { name: 'Show hidden path segments' })
      ).not.toBeInTheDocument();
    });
  });
});
