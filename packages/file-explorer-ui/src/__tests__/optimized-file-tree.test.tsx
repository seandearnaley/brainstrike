import { createFileNode } from '@brainstrike/test-utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OptimizedFileTree from '../optimized-file-tree';
import { ROW_HEIGHT as OPT_ROW_HEIGHT } from '../optimized-file-tree-row';
import { FileExplorerTestWrapper } from './test-helpers';

describe('OptimizedFileTree virtualization', () => {
  it('virtual wrapper height matches totalHeight', () => {
    const count = 80;
    const bigTree = Array.from({ length: count }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );

    render(<OptimizedFileTree fileTree={bigTree} loadingFiles={new Set()} folderId="folder" />, {
      wrapper: FileExplorerTestWrapper,
    });

    const wrapper = screen.getByTestId('file-tree');
    const expectedHeight = count * OPT_ROW_HEIGHT;
    expect(wrapper).toHaveStyle(`height: ${expectedHeight}px`);
  });

  it('no large bottom gap after scrolling near end', () => {
    const count = 120;
    const bigTree = Array.from({ length: count }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );

    render(<OptimizedFileTree fileTree={bigTree} loadingFiles={new Set()} folderId="folder" />, {
      wrapper: FileExplorerTestWrapper,
    });

    const container = screen.getByTestId('file-tree-scroll-container') as HTMLDivElement;
    Object.defineProperty(container, 'clientHeight', { value: OPT_ROW_HEIGHT * 5 });

    act(() => {
      container.scrollTop = OPT_ROW_HEIGHT * (count - 6);
      fireEvent.scroll(container);
    });

    const wrapper = screen.getByTestId('file-tree');
    const expectedHeight = count * OPT_ROW_HEIGHT;
    expect(wrapper).toHaveStyle(`height: ${expectedHeight}px`);

    const items = screen.getAllByRole('treeitem') as HTMLElement[];
    expect(items.length).toBeGreaterThan(0);
    const tops = items
      .map((el) => (el.style.top ? Number.parseInt(el.style.top.replace('px', ''), 10) : 0))
      .filter((n) => !Number.isNaN(n));
    const maxTop = Math.max(...tops);
    const lastBottom = maxTop + OPT_ROW_HEIGHT;
    expect(lastBottom).toBeGreaterThanOrEqual(expectedHeight - OPT_ROW_HEIGHT * 2);
  });
});
