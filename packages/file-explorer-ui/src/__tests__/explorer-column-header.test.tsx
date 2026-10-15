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
import { useExplorerSortStateStore } from '@brainstrike/app-state/stores/explorer-sort-state-store';
import { createLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import type { ReactNode, RefObject } from 'react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as containerWidthModule from '../hooks/use-container-width';
import { useExplorerRowMetadata } from '../indexing/file-row-metadata-context';
import { FileRowMetadataProvider } from '../indexing/file-row-metadata-provider';
import { ExplorerColumnHeader } from '../shell/explorer-column-header';
import {
  type ExplorerColumnsContextValue,
  METADATA_COLUMNS_MIN_WIDTH,
  resolveExplorerColumnWidths,
  resolveVisibleMetadataColumnIds,
  useExplorerColumnsValue,
} from '../shell/explorer-columns-context';
import { ExplorerColumnsProvider } from '../shell/explorer-columns-provider';
import { ExplorerSortProvider } from '../shell/explorer-sort-provider';
import {
  createExplorerThreadStatusStore,
  ExplorerThreadStatusContext,
} from '../shell/explorer-thread-status';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';
import { THREAD_KIND_APPEARANCE } from './thread-kind-appearance.fixture';

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
    <ExplorerSortProvider>
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
    </ExplorerSortProvider>
  );
}

/** The same header with NO `FileRowMetadataProvider` above it. */
function SeamlessHeaderHarness() {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const columnIds: readonly ExplorerMetadataColumnId[] = ['tokens'];
  const columnWidths = resolveExplorerColumnWidths({
    availableWidth: 0,
    sizes: {},
    visibleMetadataColumnIds: columnIds,
  });
  return (
    <ExplorerSortProvider>
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
      </ExplorerColumnsProvider>
    </ExplorerSortProvider>
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
    useExplorerSortStateStore.getState().reset();
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

  it('labels This thread without a sort: its marks have no order', async () => {
    const container = await renderForest(['thread', 'tokens']);
    const header = container.querySelector('[data-testid="explorer-column-header"]');
    const thread = header?.querySelector('[data-column-id="thread"]');
    expect(thread?.textContent).toBe('This thread');
    expect(thread?.querySelector('button')).toBeNull();
    expect(thread).not.toHaveAttribute('aria-sort');
    expect(header?.querySelector('[data-column-id="tokens"] button')).not.toBeNull();
  });

  it('keeps the sortable Name header when the grid is name-only', async () => {
    const container = await renderForest([]);
    const header = container.querySelector('[data-testid="explorer-column-header"]');
    expect(header).not.toBeNull();
    expect(Array.from(header?.querySelectorAll('th') ?? [], (cell) => cell.textContent)).toEqual([
      'Name',
    ]);
  });

  /**
   * BST-1209 review, minor 1: the metadata seam is optional by design, so a
   * surface without it must not OFFER a sort it cannot serve. Name still can —
   * it orders from the tree node alone.
   */
  it('offers no metadata sort affordance when the metadata seam is absent', async () => {
    const result = await act(async () =>
      render(
        <FileExplorerTestWrapper>
          <SeamlessHeaderHarness />
        </FileExplorerTestWrapper>
      )
    );
    const header = result.container.querySelector('[data-testid="explorer-column-header"]');
    const tokensHeader = header?.querySelector<HTMLTableCellElement>('[data-column-id="tokens"]');
    if (!tokensHeader) {
      throw new Error('expected a Tokens header cell');
    }

    expect(tokensHeader.textContent).toBe('Tokens');
    expect(tokensHeader.querySelector('button')).toBeNull();
    expect(tokensHeader).not.toHaveAttribute('aria-sort');
    // Non-interactive label => aria-hidden (whole-branch review F7): it is
    // decoration beside cells whose sr-only text already carries the meaning,
    // and this header is `role="presentation"` so nothing announces the cell.
    expect(tokensHeader.querySelector('span')).toHaveAttribute('aria-hidden', 'true');
    // The seamless surface is not sort-less: Name is still offered.
    expect(
      header?.querySelector('[data-column-id="name"]')?.querySelector('button')
    ).not.toBeNull();
  });

  it('uses the shared asc -> desc -> default cycle and exposes aria-sort', async () => {
    const container = await renderForest(['tokens']);
    const nameHeader = container.querySelector<HTMLTableCellElement>(
      '[data-testid="explorer-column-header"] [data-column-id="name"]'
    );
    const nameButton = nameHeader?.querySelector('button');
    if (!(nameHeader && nameButton)) {
      throw new Error('expected sortable Name header');
    }

    fireEvent.click(nameButton);
    expect(useExplorerSortStateStore.getState().sortState).toEqual({
      direction: 'asc',
      field: 'name',
    });
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(nameButton);
    expect(useExplorerSortStateStore.getState().sortState).toEqual({
      direction: 'desc',
      field: 'name',
    });
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(nameButton);
    expect(useExplorerSortStateStore.getState().sortState).toBeNull();
    expect(nameHeader).not.toHaveAttribute('aria-sort');
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

/**
 * BST-1209 review, minor 1: a persisted metadata sort that reaches a surface
 * without the seam must degrade VISIBLY — default order plus a warn — never by
 * throwing mid-render and never by quietly doing nothing.
 */
describe('metadata sort on a surface without the seam', () => {
  beforeEach(() => {
    useExplorerSortStateStore.getState().reset();
  });

  it('restores the default order and says so', async () => {
    const warn = vi
      .spyOn(createLogger('OptimizedFileTree'), 'warn')
      .mockImplementation(() => undefined);
    useExplorerSortStateStore.getState().setSortState({ direction: 'asc', field: 'tokens' });

    await act(async () =>
      render(
        <FileExplorerTestWrapper>
          <ExplorerSortProvider>
            <OptimizedFileTree fileTree={SECTION_TREE} folderId={ROOT} loadingFiles={new Set()} />
          </ExplorerSortProvider>
        </FileExplorerTestWrapper>
      )
    );

    expect(useExplorerSortStateStore.getState().sortState).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('preserves the persisted metadata sort and warns when a populated root id is not ready', async () => {
    const warn = vi
      .spyOn(createLogger('OptimizedFileTree'), 'warn')
      .mockImplementation(() => undefined);
    const persistedSort = { direction: 'asc', field: 'tokens' } as const;
    useExplorerSortStateStore.getState().setSortState(persistedSort);

    await act(async () =>
      render(
        <FileExplorerTestWrapper>
          <ExplorerSortProvider>
            <SeamProvider>
              <OptimizedFileTree fileTree={SECTION_TREE} folderId="" loadingFiles={new Set()} />
            </SeamProvider>
          </ExplorerSortProvider>
        </FileExplorerTestWrapper>
      )
    );

    expect(useExplorerSortStateStore.getState().sortState).toEqual(persistedSort);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot apply the persisted "tokens" sort until its root id is ready')
    );
    warn.mockRestore();
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

  it('never overshoots the pixel budget when proportional targets round upward together', () => {
    const next = resolveExplorerColumnWidths({
      availableWidth: 353,
      sizes: MAXED,
      visibleMetadataColumnIds: ALL_METADATA,
    });
    const total = ALL_METADATA.reduce((sum, id) => sum + (next[id] as number), 0);

    expect(total).toBe(353 - 120);
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
  const ALL_ON = { size: true, thread: true, tokens: true, type: true };

  it('suppresses every metadata column below the width threshold', () => {
    expect(
      resolveVisibleMetadataColumnIds({ isSuppressed: true, visibility: ALL_ON })
    ).toHaveLength(0);
  });

  it('keeps the canonical column order regardless of preference order', () => {
    expect(
      resolveVisibleMetadataColumnIds({
        isSuppressed: false,
        visibility: { size: true, thread: true, tokens: true, type: false },
      })
    ).toEqual(['thread', 'tokens', 'size']);
  });

  it('returns a STABLE identity for the empty result so the columns memo does not churn', () => {
    const first = resolveVisibleMetadataColumnIds({
      isSuppressed: true,
      visibility: ALL_ON,
    });
    const second = resolveVisibleMetadataColumnIds({
      isSuppressed: false,
      visibility: { size: false, thread: false, tokens: false, type: false },
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

  it('keeps the complete context identity when a resize resolves to identical pixel widths', () => {
    const columnIds = ['type', 'tokens', 'size'] as const;
    act(() => {
      for (const id of columnIds) {
        useExplorerColumnVisibilityStore.getState().setColumnVisible(id, true);
        useExplorerColumnSizesStore.getState().setColumn(id, EXPLORER_COLUMN_BOUNDS[id].maxWidth);
      }
    });
    const { result, rerender } = renderColumns(353);
    const first = result.current;

    rerender({ width: 353.4 });

    expect(result.current.columnWidths).toEqual(first.columnWidths);
    expect(result.current).toBe(first);
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
  it('shows This thread only where the active thread context is published', () => {
    vi.spyOn(containerWidthModule, 'useContainerWidth').mockReturnValue(800);
    const containerRef = { current: null } as RefObject<HTMLElement | null>;
    const without = renderHook(() => useExplorerColumnsValue(containerRef));
    expect(without.result.current.visibleMetadataColumnIds).toEqual(['tokens']);

    const store = createExplorerThreadStatusStore(THREAD_KIND_APPEARANCE);
    const withStore = renderHook(() => useExplorerColumnsValue(containerRef), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ExplorerThreadStatusContext.Provider value={store}>
          {children}
        </ExplorerThreadStatusContext.Provider>
      ),
    });
    expect(withStore.result.current.visibleMetadataColumnIds).toEqual(['thread', 'tokens']);
  });

  it('treats an unmeasured panel as narrow, so the grid never flashes columns it must drop', () => {
    const { result, rerender } = renderColumns(0);

    expect(result.current.areMetadataColumnsSuppressed).toBe(true);
    expect(result.current.visibleMetadataColumnIds).toHaveLength(0);

    rerender({ width: 800 });
    expect(result.current.areMetadataColumnsSuppressed).toBe(false);
    expect(result.current.visibleMetadataColumnIds.length).toBeGreaterThan(0);
  });
});

/**
 * The header must render at EVERY width, in BOTH layouts (whole-branch review
 * F1).
 *
 * Forest already did. Single-root gated `showColumnHeader` on the visible
 * metadata-column count, so sorting by Name and then dragging the panel under
 * 300px (or hiding every metadata column) left the rows sorted with the header
 * gone: no way to change the sort, no way to clear it, and no `aria-sort`
 * anywhere. The header is not a metadata capability — it carries the Name sort.
 */
function SeamProvider({ children }: { children: ReactNode }) {
  const rowMetadata = useExplorerRowMetadata();
  return (
    <FileRowMetadataProvider value={rowMetadata.contextValue}>{children}</FileRowMetadataProvider>
  );
}

describe('single-root header presence', () => {
  const NARROW_NAME_ONLY: ExplorerColumnsContextValue = {
    areMetadataColumnsSuppressed: true,
    columnWidths: {},
    visibleMetadataColumnIds: [],
  };

  beforeEach(() => {
    useExplorerSortStateStore.getState().reset();
  });

  function renderSingleRoot(columns: ExplorerColumnsContextValue) {
    return act(async () =>
      render(
        <FileExplorerTestWrapper>
          <ExplorerSortProvider>
            <SeamProvider>
              <ExplorerColumnsProvider value={columns}>
                <FileExplorerSidebar
                  currentFolderId={ROOT}
                  filterError={null}
                  isInitialLoad={false}
                  isLoading={false}
                  loadingFiles={new Set()}
                  quickFilteredTree={SECTION_TREE}
                  rootDirectoryHandle={{
                    _internal: {} as FileSystemDirectoryHandle,
                    kind: 'directory',
                    name: 'root',
                    path: '/',
                    platform: 'web',
                  }}
                  treeError={null}
                />
              </ExplorerColumnsProvider>
            </SeamProvider>
          </ExplorerSortProvider>
        </FileExplorerTestWrapper>
      )
    );
  }

  it('keeps the Name sort reachable with every metadata column suppressed', async () => {
    const { container } = await renderSingleRoot(NARROW_NAME_ONLY);

    const headerCells = container.querySelectorAll<HTMLTableCellElement>('thead th');
    // Name-only: exactly ONE header cell, and it is the sort affordance.
    expect(headerCells).toHaveLength(1);
    const nameHeader = headerCells[0];
    if (!nameHeader) {
      throw new Error('expected a Name header cell at name-only width');
    }

    fireEvent.click(nameHeader);
    expect(useExplorerSortStateStore.getState().sortState).toEqual({
      direction: 'asc',
      field: 'name',
    });
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

    // …and the sort stays CLEARABLE, which is the half the missing header
    // really cost: rows stayed ordered with no control to undo it.
    fireEvent.click(nameHeader);
    fireEvent.click(nameHeader);
    expect(useExplorerSortStateStore.getState().sortState).toBeNull();
  });

  it('still renders the header when metadata columns ARE visible', async () => {
    const { container } = await renderSingleRoot({
      areMetadataColumnsSuppressed: false,
      columnWidths: { tokens: 76 },
      visibleMetadataColumnIds: ['tokens'],
    });

    const headerCells = Array.from(
      container.querySelectorAll<HTMLTableCellElement>('thead th'),
      (cell) => cell.textContent
    );
    expect(headerCells).toEqual(['Name', 'Tokens']);
  });
});
