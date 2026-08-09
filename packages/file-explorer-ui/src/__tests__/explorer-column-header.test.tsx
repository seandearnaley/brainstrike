/**
 * Forest header ALIGNMENT (BST-1208).
 *
 * In forest mode the header sits above the shared scroller and the section
 * tables sit inside it — two separate `<table>` elements that must lay out
 * identical columns. jsdom has no layout, so the pin is the thing layout is
 * derived FROM: both tables are `table-fixed` with a `<colgroup>`, so identical
 * `<col>` widths in identical order guarantee identical column geometry.
 *
 * A drift in the header's column set, order, or width source fails here.
 */

import {
  EXPLORER_COLUMN_BOUNDS,
  useExplorerColumnSizesStore,
} from '@brainstrike/app-state/stores/explorer-column-sizes-store';
import type { ExplorerMetadataColumnId } from '@brainstrike/app-state/stores/explorer-column-visibility-store';
import type { IFileNode } from '@brainstrike/types';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FileRowMetadataProvider,
  useExplorerRowMetadata,
} from '../indexing/file-row-metadata-context';
import { ExplorerColumnHeader } from '../shell/explorer-column-header';
import {
  ExplorerColumnsProvider,
  resolveVisibleMetadataColumnIds,
} from '../shell/explorer-columns-context';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const ROOT = 'root';

const SECTION_TREE: IFileNode[] = [
  {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'a.ts',
    path: '/a.ts',
    rootFolderId: ROOT,
    selectionState: 'unchecked',
    size: 10,
    type: 'file',
  },
];

function colWidths(scope: Element | null): (string | undefined)[] {
  const cols = scope?.querySelectorAll('colgroup > col') ?? [];
  return Array.from(cols, (col) => (col as HTMLTableColElement).style.width || undefined);
}

function ForestHarness({ columnIds }: { columnIds: readonly ExplorerMetadataColumnId[] }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rowMetadata = useExplorerRowMetadata();
  return (
    <FileRowMetadataProvider value={rowMetadata.contextValue}>
      <ExplorerColumnsProvider
        value={{ areMetadataColumnsSuppressed: false, visibleMetadataColumnIds: columnIds }}
      >
        <ExplorerColumnHeader scrollerRef={scrollerRef} visibleMetadataColumnIds={columnIds} />
        <div data-testid="forest-sections-scroll" ref={scrollerRef}>
          <OptimizedFileTree
            fileTree={SECTION_TREE}
            folderId={ROOT}
            loadingFiles={new Set()}
            scrollParentRef={scrollerRef}
          />
        </div>
      </ExplorerColumnsProvider>
    </FileRowMetadataProvider>
  );
}

async function renderForest(columnIds: readonly ExplorerMetadataColumnId[]): Promise<HTMLElement> {
  const result = await act(async () =>
    render(
      <FileExplorerTestWrapper>
        <ForestHarness columnIds={columnIds} />
      </FileExplorerTestWrapper>
    )
  );
  return result.container;
}

describe('forest column header', () => {
  beforeEach(() => {
    useExplorerColumnSizesStore.getState().reset();
  });

  it('lays out the same columns, in the same order, at the same widths as the section table', async () => {
    const container = await renderForest(['type', 'tokens', 'size']);

    const header = container.querySelector('[data-testid="explorer-column-header"]');
    const sectionTable = container.querySelector('[data-testid="file-tree"] table');
    expect(header).not.toBeNull();
    expect(sectionTable).not.toBeNull();

    const headerWidths = colWidths(header);
    expect(headerWidths).toEqual(colWidths(sectionTable));
    // Name carries no width on EITHER side — table-fixed hands it the remainder.
    expect(headerWidths[0]).toBeUndefined();
    expect(headerWidths.slice(1)).toEqual([
      `${EXPLORER_COLUMN_BOUNDS.type.defaultWidth}px`,
      `${EXPLORER_COLUMN_BOUNDS.tokens.defaultWidth}px`,
      `${EXPLORER_COLUMN_BOUNDS.size.defaultWidth}px`,
    ]);
  });

  it('follows a resize on both sides of the scroller boundary', async () => {
    const container = await renderForest(['tokens']);

    act(() => {
      useExplorerColumnSizesStore.getState().setColumn('tokens', 140);
    });

    const header = container.querySelector('[data-testid="explorer-column-header"]');
    const sectionTable = container.querySelector('[data-testid="file-tree"] table');
    expect(colWidths(header)).toEqual([undefined, '140px']);
    expect(colWidths(header)).toEqual(colWidths(sectionTable));
  });

  it('renders only the visible columns', async () => {
    const container = await renderForest(['tokens']);
    const headers = Array.from(
      container.querySelectorAll('[data-testid="explorer-column-header"] th'),
      (cell) => cell.textContent
    );
    expect(headers).toEqual(['Name', 'Tokens']);
  });

  it('renders nothing at all when the grid is name-only', async () => {
    const container = await renderForest([]);
    expect(container.querySelector('[data-testid="explorer-column-header"]')).toBeNull();
  });

  it('exposes a resize handle per metadata column and none for the pinned Name column', async () => {
    const container = await renderForest(['type', 'tokens', 'size']);
    const handles = Array.from(
      container.querySelectorAll('[data-testid="explorer-column-header"] [role="separator"]'),
      (handle) => handle.getAttribute('data-testid')
    );
    expect(handles).toEqual([
      'tree-table-resize-handle-type',
      'tree-table-resize-handle-tokens',
      'tree-table-resize-handle-size',
    ]);
  });
});

describe('responsive column resolution', () => {
  const ALL_ON = { size: true, tokens: true, type: true };

  it('suppresses every metadata column below the width threshold', () => {
    expect(
      resolveVisibleMetadataColumnIds({ isSuppressed: true, visibility: ALL_ON })
    ).toHaveLength(0);
  });

  it('keeps the canonical column order regardless of preference order', () => {
    expect(
      resolveVisibleMetadataColumnIds({
        isSuppressed: false,
        visibility: { size: true, tokens: true, type: false },
      })
    ).toEqual(['tokens', 'size']);
  });

  it('returns a STABLE identity for the empty result so the columns memo does not churn', () => {
    const first = resolveVisibleMetadataColumnIds({
      isSuppressed: true,
      visibility: ALL_ON,
    });
    const second = resolveVisibleMetadataColumnIds({
      isSuppressed: false,
      visibility: { size: false, tokens: false, type: false },
    });
    expect(first).toBe(second);
  });
});
