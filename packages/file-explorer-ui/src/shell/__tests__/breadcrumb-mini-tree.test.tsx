/**
 * Breadcrumb popover navigator (BST-1319), rendered through the shared
 * TreeTable per the ui-conventions treegrid contract — virtualization, ARIA
 * row metadata, and keyboard traversal are TreeTable's (covered by its own
 * tests); pinned here is the ADAPTER contract: entries → pre-flattened
 * nodes, the clicked segment highlighted, file activation picks, directory
 * activation toggles, and synthetic error entries render as inert rows.
 */

import type { IFileNode } from '@brainstrike/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BreadcrumbMiniTree } from '../breadcrumb-mini-tree';
import type { MiniTreeEntry } from '../breadcrumb-mini-tree-entries';

// Mock @tanstack/react-virtual to avoid JSDOM dimension issues (same pattern
// as packages/ui tree-table tests): render every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getTotalSize: () => count * 26,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        end: (i + 1) * 26,
        index: i,
        key: `item-${i}`,
        size: 26,
        start: i * 26,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  })),
}));

function node(path: string, type: 'file' | 'directory'): IFileNode {
  return {
    depth: 0,
    handle: {} as unknown as IFileNode['handle'],
    name: path.split('/').pop() ?? path,
    path,
    type,
  } as IFileNode;
}

const ENTRIES: readonly MiniTreeEntry[] = [
  { depth: 0, kind: 'node', node: node('/root/src/app.ts', 'file') },
  { depth: 0, kind: 'node', node: node('/root/src/ui', 'directory') },
];

function renderTree(overrides?: {
  entries?: readonly MiniTreeEntry[];
  expandedPaths?: ReadonlySet<string>;
}) {
  const onPickFile = vi.fn();
  const onToggleDir = vi.fn();
  render(
    <BreadcrumbMiniTree
      entries={overrides?.entries ?? ENTRIES}
      expandedPaths={overrides?.expandedPaths ?? new Set()}
      loadingPaths={new Set()}
      onPickFile={onPickFile}
      onToggleDir={onToggleDir}
      selectedPath="/root/src/app.ts"
    />
  );
  return { onPickFile, onToggleDir };
}

describe('BreadcrumbMiniTree', () => {
  it('renders the shared treegrid with the clicked segment selected', () => {
    renderTree();

    const grid = screen.getByRole('treegrid', { name: 'Breadcrumb navigator' });
    expect(grid).toBeInTheDocument();
    const appRow = screen.getByRole('row', { name: /app\.ts/ });
    const uiRow = screen.getByRole('row', { name: /ui/ });
    expect(appRow).toHaveAttribute('aria-selected', 'true');
    expect(uiRow).toHaveAttribute('aria-selected', 'false');
    // Directories advertise expandability; files never carry aria-expanded.
    expect(uiRow).toHaveAttribute('aria-expanded', 'false');
    expect(appRow).not.toHaveAttribute('aria-expanded');
    // Full ARIA row metadata comes from TreeTable (posinset/setsize/level).
    expect(appRow).toHaveAttribute('aria-posinset', '1');
    expect(appRow).toHaveAttribute('aria-setsize', '2');
    expect(appRow).toHaveAttribute('aria-level', '1');
  });

  it('activating a file picks it; activating a directory toggles expansion', () => {
    const { onPickFile, onToggleDir } = renderTree();

    fireEvent.click(screen.getByRole('row', { name: /app\.ts/ }));
    expect(onPickFile).toHaveBeenCalledExactlyOnceWith('/root/src/app.ts');

    fireEvent.click(screen.getByRole('row', { name: /ui/ }));
    expect(onToggleDir).toHaveBeenCalledExactlyOnceWith('/root/src/ui');
  });

  it('renders expanded children with nested ARIA levels', () => {
    renderTree({
      entries: [
        ...ENTRIES,
        { depth: 1, kind: 'node', node: node('/root/src/ui/button.ts', 'file') },
      ],
      expandedPaths: new Set(['/root/src/ui']),
    });

    expect(screen.getByRole('row', { name: /ui/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('row', { name: /button\.ts/ })).toHaveAttribute('aria-level', '2');
  });

  it('synthetic error entries render as inert rows (visible degradation)', () => {
    const { onPickFile, onToggleDir } = renderTree({
      entries: [
        ...ENTRIES,
        {
          depth: 1,
          kind: 'error',
          message: 'Could not load this folder.',
          path: '/root/src/ui#load-error',
        },
      ],
      expandedPaths: new Set(['/root/src/ui']),
    });

    const errorRow = screen.getByRole('row', { name: /Could not load this folder/ });
    expect(errorRow).toBeInTheDocument();
    fireEvent.click(errorRow);
    expect(onPickFile).not.toHaveBeenCalled();
    expect(onToggleDir).not.toHaveBeenCalled();
  });
});
