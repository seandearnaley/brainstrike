/**
 * Shared-scroller (scrollParentRef) contract.
 *
 * Forest sections stack multiple TreeTables inside ONE scrolling column. A
 * per-table scrollbar inside that column stretches to content height and
 * never scrolls, freezing the virtual window (blank rows on scroll — the
 * regression this mode fixes). In shared-scroller mode the viewport must be
 * a non-scrolling spacer and the virtualizer must window against the
 * ancestor via TanStack's scrollMargin.
 *
 * jsdom cannot express real scroll geometry; behavioral windowing at scale
 * is pinned by the forest e2e spec (forest-expand-all.test.ts). These tests
 * pin the structural contract.
 */

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TreeTable } from '../tree-table/tree-table';
import type { TreeNode, TreeTableColumn } from '../tree-table/types';

interface CapturedVirtualizerOptions {
  count: number;
  getScrollElement: () => HTMLElement | null;
  scrollMargin?: number;
}

const capturedVirtualizerOptions = vi.hoisted(() => ({
  current: [] as CapturedVirtualizerOptions[],
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn((options: CapturedVirtualizerOptions) => {
    capturedVirtualizerOptions.current.push(options);
    const count = options.count;
    return {
      getTotalSize: () => count * 40,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          end: (i + 1) * 40,
          index: i,
          key: `item-${i}`,
          size: 40,
          start: i * 40,
        })),
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    };
  }),
}));

interface TestData {
  name: string;
}

const NODES: TreeNode<TestData>[] = Array.from({ length: 3 }, (_, i) => ({
  data: { name: `node-${i}` },
  depth: 0,
  hasChildren: false,
  id: `n${i}`,
  parentId: null,
  type: 'file',
}));

const COLUMNS: TreeTableColumn<TestData>[] = [
  { cell: ({ node }) => node.data.name, header: 'Name', id: 'name' },
];

function findViewport(container: HTMLElement): HTMLElement {
  // The viewport is the only element that carries an overflow class — the
  // outer wrapper is overflow-hidden and everything else is overflow-free.
  const viewport = container.querySelector('.overflow-auto, .overflow-visible');
  if (!(viewport instanceof HTMLElement)) {
    throw new Error('viewport not found');
  }
  return viewport;
}

describe('TreeTable shared-scroller mode', () => {
  it('keeps the internal viewport as the scroll owner by default', () => {
    const { container } = render(
      <TreeTable columns={COLUMNS} expandedIds={new Set()} nodes={NODES} onToggleExpand={vi.fn()} />
    );

    const viewport = findViewport(container);
    expect(viewport.className).toContain('overflow-auto');
    expect(viewport.className).not.toContain('overflow-visible');
    // maxHeight cap applies only when the viewport owns scrolling.
    expect(viewport.style.maxHeight).toBe('600px');
  });

  it('renders a non-scrolling spacer viewport when a scroll parent is provided', () => {
    const scrollParent = document.createElement('div');
    const scrollParentRef = { current: scrollParent };
    const { container } = render(
      <TreeTable
        columns={COLUMNS}
        expandedIds={new Set()}
        nodes={NODES}
        onToggleExpand={vi.fn()}
        scrollParentRef={scrollParentRef}
      />
    );

    const viewport = findViewport(container);
    // A nested scrollbar inside the shared column would stretch to content
    // height and freeze the virtual window — the exact regression this mode
    // exists to prevent.
    expect(viewport.className).toContain('overflow-visible');
    expect(viewport.className).not.toContain('overflow-auto');
    expect(viewport.style.maxHeight).toBe('');
  });

  it('windows against the scroll parent with a scrollMargin option', () => {
    capturedVirtualizerOptions.current.length = 0;
    const scrollParent = document.createElement('div');
    const scrollParentRef = { current: scrollParent };
    render(
      <TreeTable
        columns={COLUMNS}
        expandedIds={new Set()}
        nodes={NODES}
        onToggleExpand={vi.fn()}
        scrollParentRef={scrollParentRef}
      />
    );

    const options = capturedVirtualizerOptions.current.at(-1);
    if (!options) {
      throw new Error('virtualizer options were not captured');
    }
    expect(options.getScrollElement()).toBe(scrollParent);
    expect(typeof options.scrollMargin).toBe('number');
  });

  it('self-heals when the scroll parent ref attaches after the first layout effect', async () => {
    // React attaches ANCESTOR host refs after descendant layout effects in
    // the same commit — the margin hook must re-arm until the ref exists
    // instead of freezing at 0 with no observers for the table's lifetime.
    const observedTargets: Element[] = [];
    class RecordingResizeObserver {
      disconnect(): void {}
      observe(target: Element): void {
        observedTargets.push(target);
      }
      unobserve(): void {}
    }
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
    try {
      const scrollParentRef: { current: HTMLElement | null } = { current: null };
      render(
        <TreeTable
          columns={COLUMNS}
          expandedIds={new Set()}
          nodes={NODES}
          onToggleExpand={vi.fn()}
          scrollParentRef={scrollParentRef}
        />
      );
      expect(observedTargets).toHaveLength(0);

      // Ancestor ref attaches after the commit (the race under guard).
      const scrollParent = document.createElement('div');
      scrollParentRef.current = scrollParent;

      // The rAF re-arm must eventually wire the observers to the parent.
      await vi.waitFor(() => {
        expect(observedTargets).toContain(scrollParent);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the internal scroll element when only non-virtual strategies run', () => {
    capturedVirtualizerOptions.current.length = 0;
    const scrollParent = document.createElement('div');
    const scrollParentRef = { current: scrollParent };
    const { container } = render(
      <TreeTable
        columns={COLUMNS}
        expandedIds={new Set()}
        nodes={NODES}
        onToggleExpand={vi.fn()}
        pagination={{ pageSize: 2 }}
        scrollParentRef={scrollParentRef}
        windowingStrategy="paged"
      />
    );

    // Paged mode renders plain rows; the shared-scroller opt-in must not
    // strip the viewport's own scrolling there.
    const viewport = findViewport(container);
    expect(viewport.className).toContain('overflow-auto');
  });
});
