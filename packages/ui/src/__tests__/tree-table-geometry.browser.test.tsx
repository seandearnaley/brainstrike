import './tree-table-geometry.browser.css';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { TreeTable } from '../tree-table/tree-table';
import type { TreeNode, TreeTableColumn } from '../tree-table/types';

afterEach(cleanup);
interface Data {
  height: number;
}
const columns: TreeTableColumn<Data>[] = [
  {
    cell: ({ node }) => <div style={{ height: node.data.height }}>{node.id}</div>,
    className: 'p-0',
    id: 'name',
  },
];
const nodes = (count: number, height = 34): TreeNode<Data>[] =>
  Array.from({ length: count }, (_, i) => ({
    data: { height },
    depth: 0,
    hasChildren: false,
    id: `row-${i}`,
    parentId: null,
    type: 'file',
  }));
function Fixture({ rows }: { rows: TreeNode<Data>[] }) {
  return (
    <div style={{ height: 400, width: 440 }}>
      <TreeTable
        className="border-separate border-spacing-0"
        columns={columns}
        expandedIds={new Set()}
        maxHeight="none"
        nodes={rows}
        nodesArePreFlattened
        onToggleExpand={() => {}}
        rowClassName="border-0"
        rowHeight={(node) => node.data.height}
        showHeader={false}
        windowingStrategy="virtual"
      />
    </div>
  );
}

// Let the real scroll observer and its 150ms idle notification settle before
// checking geometry; an immediate assertion can accidentally pass on the old DOM.
async function scrollTo(viewport: HTMLElement, top: number): Promise<void> {
  await act(async () => {
    viewport.scrollTop = top;
    viewport.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

test('keeps the viewport filled after a scrolled list shrinks', async () => {
  const all = nodes(100);
  const view = render(<Fixture rows={all} />);
  const viewport = screen.getByTestId('tree-table-viewport');
  await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(3000));
  await scrollTo(viewport, 2000);
  await waitFor(() => expect(viewport.querySelector('[data-node-id="row-60"]')).not.toBeNull());
  view.rerender(<Fixture rows={all.slice(0, 13)} />);
  await waitFor(() => {
    const row = viewport.querySelector('[data-node-id]')!;
    expect(
      row.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    ).toBeLessThanOrEqual(4);
  });
});

test('keeps measured heights with row identity when rows are reordered', async () => {
  const all = nodes(40);
  all[0]!.data.height = 280;
  const view = render(<Fixture rows={all} />);
  const viewport = screen.getByTestId('tree-table-viewport');
  await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(1400));
  await scrollTo(viewport, 600);
  await waitFor(() => expect(viewport.querySelector('[data-node-id="row-15"]')).not.toBeNull());
  view.rerender(<Fixture rows={[...all.slice(1), all[0]!]} />);
  await scrollTo(viewport, 0);
  await waitFor(() => expect(viewport.querySelector('[data-node-id="row-1"]')).not.toBeNull());
  await waitFor(() => expect(viewport.scrollHeight).toBe(1606));
});

test('reattaches measurements after an empty result replaces the viewport', async () => {
  const all = nodes(100);
  const view = render(<Fixture rows={all} />);
  let viewport = screen.getByTestId('tree-table-viewport');
  await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(3000));
  await scrollTo(viewport, 2000);
  await waitFor(() => expect(viewport.querySelector('[data-node-id="row-60"]')).not.toBeNull());
  view.rerender(<Fixture rows={[]} />);
  view.rerender(<Fixture rows={all} />);
  viewport = screen.getByTestId('tree-table-viewport');
  await waitFor(() => {
    const row = viewport.querySelector('[data-node-id]')!;
    expect(
      row.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    ).toBeLessThanOrEqual(4);
  });
  await scrollTo(viewport, 2000);
  await waitFor(() => expect(viewport.querySelector('[data-node-id="row-60"]')).not.toBeNull());
});

test('does not leave a blank viewport when a tall measured row moves below the window', async () => {
  const all = nodes(80);
  all[0]!.data.height = 900;
  const view = render(<Fixture rows={all} />);
  const viewport = screen.getByTestId('tree-table-viewport');
  await waitFor(() =>
    expect(viewport.querySelector('[data-node-id="row-0"]')!.getBoundingClientRect().height).toBe(
      900
    )
  );
  view.rerender(<Fixture rows={[...all.slice(1), all[0]!]} />);
  await scrollTo(viewport, 500);
  await waitFor(() => {
    const rows = [...viewport.querySelectorAll('[data-node-id]')];
    const box = viewport.getBoundingClientRect();
    expect(
      rows.some((row) => {
        const r = row.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      })
    ).toBe(true);
  });
});

test.each([32, 40])('aligns disclosure and selection to a %ipx first line', async (lineHeight) => {
  const rows = nodes(1);
  rows[0]!.hasChildren = true;
  render(
    <div style={{ height: 400, width: 440 }}>
      <TreeTable
        columns={[
          {
            cell: () => (
              <div>
                <div data-testid="primary-line" style={{ height: lineHeight }}>
                  Thread title
                </div>
                <div style={{ height: 120 }}>Details</div>
              </div>
            ),
            id: 'thread',
            treeControlLineHeight: () => lineHeight,
            treeControlsPosition: 'top',
          },
        ]}
        expandedIds={new Set()}
        nodes={rows}
        onToggleExpand={() => {}}
        showCheckbox
        showHeader={false}
      />
    </div>
  );
  const center = (element: Element) => {
    const r = element.getBoundingClientRect();
    return r.top + r.height / 2;
  };
  expect(center(screen.getByRole('button', { name: 'Expand' }))).toBe(
    center(screen.getByTestId('primary-line'))
  );
  expect(center(screen.getByRole('checkbox'))).toBe(center(screen.getByTestId('primary-line')));
});
