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
import {
  type ExplorerMetadataColumnId,
  useExplorerColumnVisibilityStore,
} from '@brainstrike/app-state/stores/explorer-column-visibility-store';
import type { IFileNode } from '@brainstrike/types';
import { act, render, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as containerWidthModule from '../hooks/use-container-width';
import {
  FileRowMetadataProvider,
  useExplorerRowMetadata,
} from '../indexing/file-row-metadata-context';
import { ExplorerColumnHeader } from '../shell/explorer-column-header';
import {
  ExplorerColumnsProvider,
  METADATA_COLUMNS_MIN_WIDTH,
  resolveExplorerColumnWidths,
  resolveVisibleMetadataColumnIds,
  useExplorerColumnsValue,
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

function ForestHarness({
  availableWidth,
  columnIds,
}: {
  availableWidth: number;
  columnIds: readonly ExplorerMetadataColumnId[];
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rowMetadata = useExplorerRowMetadata();
  // The real production path: persisted widths shrunk to the panel, then fed to
  // BOTH the header and the section tables from one place.
  // Subscribed, exactly as `useExplorerColumnsValue` does in production, so a
  // resize re-renders both sides of the scroller boundary.
  const sizes = useExplorerColumnSizesStore((state) => state.sizes);
  const columnWidths = resolveExplorerColumnWidths({
    availableWidth,
    sizes,
    visibleMetadataColumnIds: columnIds,
  });
  return (
    <FileRowMetadataProvider value={rowMetadata.contextValue}>
      <ExplorerColumnsProvider
        value={{
          areMetadataColumnsSuppressed: false,
          columnWidths,
          visibleMetadataColumnIds: columnIds,
        }}
      >
        <ExplorerColumnHeader
          columnWidths={columnWidths}
          scrollerRef={scrollerRef}
          visibleMetadataColumnIds={columnIds}
        />
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

/** `availableWidth: 0` means "unmeasured", which passes widths through as-is. */
async function renderForest(
  columnIds: readonly ExplorerMetadataColumnId[],
  availableWidth = 0
): Promise<HTMLElement> {
  const result = await act(async () =>
    render(
      <FileExplorerTestWrapper>
        <ForestHarness availableWidth={availableWidth} columnIds={columnIds} />
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

  /**
   * The defect this pins, reproduced live before the fix: with all three
   * metadata columns dragged to their 160px maximum inside a ~354px panel, the
   * 480px of fixed columns left the Name column at ZERO — filenames vanished —
   * and the trailing column was clipped off-panel with no way to reach it (the
   * section wrapper is `overflow-hidden` per the TreeGrid contract, so the
   * overflow could not even become a scrollbar). Widths must shrink to fit, and
   * the header must shrink with the body.
   */
  it('shrinks to fit — and stays aligned — when persisted widths exceed the panel', async () => {
    for (const columnId of ['type', 'tokens', 'size'] as const) {
      act(() => {
        useExplorerColumnSizesStore
          .getState()
          .setColumn(columnId, EXPLORER_COLUMN_BOUNDS[columnId].maxWidth);
      });
    }
    const availableWidth = 354;
    const container = await renderForest(['type', 'tokens', 'size'], availableWidth);

    const header = container.querySelector('[data-testid="explorer-column-header"]');
    const sectionTable = container.querySelector('[data-testid="file-tree"] table');
    const headerWidths = colWidths(header);

    // Still one grid across the scroller boundary.
    expect(headerWidths).toEqual(colWidths(sectionTable));

    const metadataTotal = headerWidths
      .slice(1)
      .reduce((total, width) => total + Number.parseInt(width ?? '0', 10), 0);
    // The Name column keeps a readable share instead of collapsing to zero.
    expect(metadataTotal).toBeLessThanOrEqual(availableWidth - 120);
    expect(metadataTotal).toBeGreaterThan(0);
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

describe('explorer column width clamping', () => {
  const ALL_METADATA = ['type', 'tokens', 'size'] as const;
  const MAXED: Record<string, number> = {
    size: EXPLORER_COLUMN_BOUNDS.size.maxWidth,
    tokens: EXPLORER_COLUMN_BOUNDS.tokens.maxWidth,
    type: EXPLORER_COLUMN_BOUNDS.type.maxWidth,
  };

  it('passes widths through untouched while the panel is unmeasured', () => {
    for (const availableWidth of [0, Number.NaN]) {
      expect(
        resolveExplorerColumnWidths({
          availableWidth,
          sizes: MAXED,
          visibleMetadataColumnIds: ALL_METADATA,
        })
      ).toBe(MAXED);
    }
  });

  it('leaves widths alone when they already fit', () => {
    const sizes = { size: 76, tokens: 76, type: 72 };
    expect(
      resolveExplorerColumnWidths({
        availableWidth: 800,
        sizes,
        visibleMetadataColumnIds: ALL_METADATA,
      })
    ).toBe(sizes);
  });

  it('shrinks proportionally, never below a column minimum, and reserves the Name column', () => {
    const next = resolveExplorerColumnWidths({
      availableWidth: 354,
      sizes: MAXED,
      visibleMetadataColumnIds: ALL_METADATA,
    });
    const total = ALL_METADATA.reduce((sum, id) => sum + (next[id] as number), 0);
    expect(total).toBeLessThanOrEqual(354 - 120);
    for (const id of ALL_METADATA) {
      expect(next[id]).toBeGreaterThanOrEqual(EXPLORER_COLUMN_BOUNDS[id].minWidth);
    }
  });

  it('falls back to the column minimums when even those do not fit', () => {
    const next = resolveExplorerColumnWidths({
      availableWidth: 200,
      sizes: MAXED,
      visibleMetadataColumnIds: ALL_METADATA,
    });
    expect(next).toMatchObject({
      size: EXPLORER_COLUMN_BOUNDS.size.minWidth,
      tokens: EXPLORER_COLUMN_BOUNDS.tokens.minWidth,
      type: EXPLORER_COLUMN_BOUNDS.type.minWidth,
    });
  });

  it('preserves stored widths for columns that are not on screen', () => {
    const next = resolveExplorerColumnWidths({
      availableWidth: 354,
      sizes: { ...MAXED, tokens: 160 },
      visibleMetadataColumnIds: ['type', 'size'],
    });
    // `tokens` is hidden: its stored width must survive the shrink untouched so
    // re-enabling the column restores what the user chose.
    expect(next['tokens']).toBe(160);
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

/**
 * The id array is the memo key for the `TreeTableColumn[]` that reaches
 * `TreeTableRow`'s memo, so a fresh identity for an unchanged answer rebuilds
 * every cell closure and re-renders every visible row. Only the EMPTY result
 * used to be identity-stable, which meant a panel-width drag re-rendered the
 * whole viewport once per pixel.
 */
describe('column id identity stability', () => {
  function renderColumns(containerWidth: number) {
    const containerRef = { current: null } as RefObject<HTMLElement | null>;
    return renderHook(
      ({ width }: { width: number }) => {
        // `useContainerWidth` needs a live element; drive the measured width
        // directly so the test controls the responsive input.
        vi.spyOn(containerWidthModule, 'useContainerWidth').mockReturnValue(width);
        return useExplorerColumnsValue(containerRef);
      },
      { initialProps: { width: containerWidth } }
    );
  }

  beforeEach(() => {
    useExplorerColumnVisibilityStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps ONE non-empty id array across re-renders that change nothing', () => {
    const { result, rerender } = renderColumns(800);
    const first = result.current.visibleMetadataColumnIds;
    expect(first.length).toBeGreaterThan(0);

    rerender({ width: 800 });
    expect(result.current.visibleMetadataColumnIds).toBe(first);
  });

  it('keeps the id array identity across a RESIZE that does not change the answer', () => {
    const { result, rerender } = renderColumns(800);
    const first = result.current.visibleMetadataColumnIds;

    // A panel drag: width moves every frame, the visible columns do not.
    rerender({ width: 780 });
    rerender({ width: 761 });
    expect(result.current.visibleMetadataColumnIds).toBe(first);
  });

  it('DOES mint a new identity when the visible set actually changes', () => {
    const { result, rerender } = renderColumns(800);
    const first = result.current.visibleMetadataColumnIds;

    act(() => {
      useExplorerColumnVisibilityStore.getState().setColumnVisible('size', true);
    });
    rerender({ width: 800 });

    expect(result.current.visibleMetadataColumnIds).not.toBe(first);
    expect(result.current.visibleMetadataColumnIds).toContain('size');
  });

  it('collapses to the shared empty array once the panel is too narrow', () => {
    const { result, rerender } = renderColumns(800);
    rerender({ width: METADATA_COLUMNS_MIN_WIDTH - 1 });

    expect(result.current.areMetadataColumnsSuppressed).toBe(true);
    expect(result.current.visibleMetadataColumnIds).toHaveLength(0);
  });

  /**
   * Whole-branch review F10. Width 0 means "not measured yet", and guessing
   * ROOMY flashed the metadata columns on for one frame in every panel too
   * narrow to keep them — the grid painted three columns, the first
   * ResizeObserver callback took them away, and `table-fixed` re-laid the Name
   * column across the full width. The narrow guess only ever adds columns.
   */
  it('treats an unmeasured panel as narrow, so the grid never flashes columns it must drop', () => {
    const { result, rerender } = renderColumns(0);

    expect(result.current.areMetadataColumnsSuppressed).toBe(true);
    expect(result.current.visibleMetadataColumnIds).toHaveLength(0);

    rerender({ width: 800 });
    expect(result.current.areMetadataColumnsSuppressed).toBe(false);
    expect(result.current.visibleMetadataColumnIds.length).toBeGreaterThan(0);
  });
});
