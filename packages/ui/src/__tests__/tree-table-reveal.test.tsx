/**
 * `treeTableRef.revealNode` imperative contract (BST-1269).
 *
 * Per-file explorer panes reveal a tab's directory after programmatic
 * expansion. jsdom cannot express real scroll geometry, so these tests pin
 * the virtualizer CALL contract: revealNode resolves the node's flattened
 * row index and delegates to scrollToIndex (align auto — same path keyboard
 * navigation uses), and unknown ids are a no-op.
 */

import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TreeTable } from '../tree-table/tree-table';
import type { TreeNode, TreeTableColumn, TreeTableHandle } from '../tree-table/types';

interface CapturedVirtualizer {
  options: { count: number; estimateSize: (index: number) => number };
  scrollToIndex: ReturnType<typeof vi.fn>;
}

const capturedVirtualizers = vi.hoisted(() => ({
  current: [] as CapturedVirtualizer[],
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn((options: { count: number; estimateSize: (index: number) => number }) => {
    const scrollToIndex = vi.fn();
    capturedVirtualizers.current.push({ options, scrollToIndex });
    const count = options.count;
    return {
      getTotalSize: () => count * 29,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          end: (i + 1) * 29,
          index: i,
          key: `item-${i}`,
          size: 29,
          start: i * 29,
        })),
      measureElement: vi.fn(),
      measurementsCache: [],
      scrollToIndex,
      scrollToOffset: vi.fn(),
    };
  }),
}));

interface TestData {
  name: string;
}

const NODES: TreeNode<TestData>[] = Array.from({ length: 5 }, (_, i) => ({
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

function latestVirtualizer(): CapturedVirtualizer {
  const captured = capturedVirtualizers.current.at(-1);
  if (!captured) {
    throw new Error('virtualizer not captured');
  }
  return captured;
}

describe('TreeTable revealNode', () => {
  it('scrolls to the flattened row index of the requested node', () => {
    const ref = createRef<TreeTableHandle>();
    render(
      <TreeTable
        columns={COLUMNS}
        expandedIds={new Set()}
        nodes={NODES}
        onToggleExpand={vi.fn()}
        rowHeight={29}
        treeTableRef={ref}
      />
    );

    // The pane tree uses fixed 29px rows; the virtualizer estimate must agree
    // or reveal offsets drift on unmeasured rows.
    expect(latestVirtualizer().options.estimateSize(3)).toBe(29);

    ref.current?.revealNode('n3');
    expect(latestVirtualizer().scrollToIndex).toHaveBeenCalledWith(3, {
      align: 'auto',
      behavior: 'auto',
    });
  });

  it('ignores unknown node ids', () => {
    const ref = createRef<TreeTableHandle>();
    render(
      <TreeTable
        columns={COLUMNS}
        expandedIds={new Set()}
        nodes={NODES}
        onToggleExpand={vi.fn()}
        rowHeight={29}
        treeTableRef={ref}
      />
    );

    ref.current?.revealNode('missing');
    expect(latestVirtualizer().scrollToIndex).not.toHaveBeenCalled();
  });
});
