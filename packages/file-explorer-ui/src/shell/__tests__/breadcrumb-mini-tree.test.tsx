/**
 * Breadcrumb popover mini-tree rows (BST-1319): a compact WAI-ARIA tree of a
 * directory's contents — the clicked segment highlighted, directories
 * expandable in place, files pickable — with roving-focus keyboard support
 * (arrows/Enter). Data resolution is covered by the entries helpers; this is
 * the presentational contract.
 */

import type { IFileNode } from '@brainstrike/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BreadcrumbMiniTree } from '../breadcrumb-mini-tree';
import type { MiniTreeEntry } from '../breadcrumb-mini-tree-entries';

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
  { depth: 0, node: node('/root/src/app.ts', 'file') },
  { depth: 0, node: node('/root/src/ui', 'directory') },
];

function renderTree(overrides?: {
  entries?: readonly MiniTreeEntry[];
  onPickFile?: (path: string) => void;
  onToggleDir?: (path: string) => void;
  expandedPaths?: ReadonlySet<string>;
}) {
  const onPickFile = overrides?.onPickFile ?? vi.fn();
  const onToggleDir = overrides?.onToggleDir ?? vi.fn();
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
  it('renders a WAI-ARIA tree with the clicked segment selected', () => {
    renderTree();

    const tree = screen.getByRole('tree', { name: 'Breadcrumb navigator' });
    expect(tree).toBeInTheDocument();
    const items = screen.getAllByRole('treeitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('aria-selected', 'true');
    expect(items[1]).toHaveAttribute('aria-selected', 'false');
    // Directories advertise expandability; files never carry aria-expanded.
    expect(items[1]).toHaveAttribute('aria-expanded', 'false');
    expect(items[0]).not.toHaveAttribute('aria-expanded');
  });

  it('clicking a file picks it; clicking a directory toggles expansion', () => {
    const { onPickFile, onToggleDir } = renderTree();

    fireEvent.click(screen.getByRole('treeitem', { name: 'app.ts' }));
    expect(onPickFile).toHaveBeenCalledExactlyOnceWith('/root/src/app.ts');

    fireEvent.click(screen.getByRole('treeitem', { name: 'ui' }));
    expect(onToggleDir).toHaveBeenCalledExactlyOnceWith('/root/src/ui');
  });

  it('supports roving arrow-key focus and Enter activation', () => {
    const { onPickFile, onToggleDir } = renderTree();
    const items = screen.getAllByRole('treeitem');

    items[0]?.focus();
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Enter' });
    expect(onToggleDir).toHaveBeenCalledExactlyOnceWith('/root/src/ui');

    fireEvent.keyDown(items[1] as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'Enter' });
    expect(onPickFile).toHaveBeenCalledExactlyOnceWith('/root/src/app.ts');
  });

  it('ArrowRight expands a collapsed dir; ArrowLeft collapses an expanded one', () => {
    const { onToggleDir } = renderTree();
    const dir = screen.getByRole('treeitem', { name: 'ui' });

    dir.focus();
    fireEvent.keyDown(dir, { key: 'ArrowRight' });
    expect(onToggleDir).toHaveBeenCalledExactlyOnceWith('/root/src/ui');
  });

  it('collapse via ArrowLeft only fires for expanded directories', () => {
    const { onToggleDir } = renderTree({ expandedPaths: new Set(['/root/src/ui']) });
    const dir = screen.getByRole('treeitem', { name: 'ui' });
    expect(dir).toHaveAttribute('aria-expanded', 'true');

    dir.focus();
    fireEvent.keyDown(dir, { key: 'ArrowLeft' });
    expect(onToggleDir).toHaveBeenCalledExactlyOnceWith('/root/src/ui');

    const file = screen.getByRole('treeitem', { name: 'app.ts' });
    file.focus();
    fireEvent.keyDown(file, { key: 'ArrowLeft' });
    expect(onToggleDir).toHaveBeenCalledTimes(1);
  });
});
