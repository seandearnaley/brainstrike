/**
 * Column definitions for the Explorer tree grid (BST-1208).
 *
 * ONE source of truth for the columns, shared by three renderers: the
 * per-tree `TreeTable` (which owns the single-root sticky header), the
 * panel-level forest header, and the toolbar's visibility control. Splitting
 * that would let the forest header drift out of alignment with the section
 * tables it sits above — the exact failure this layer has to avoid.
 *
 * Sizing bounds come from `EXPLORER_COLUMN_BOUNDS` in app-state, the same map
 * that clamps the persisted widths, so the store can never hold a width the
 * column renderer would reject.
 *
 * Name is the tree column: pinned, never hideable, and deliberately WITHOUT a
 * width so `table-fixed` gives it whatever the metadata columns leave over.
 */

import { EXPLORER_COLUMN_BOUNDS } from '@brainstrike/app-state/stores/explorer-column-sizes-store';
import type { ExplorerMetadataColumnId } from '@brainstrike/app-state/stores/explorer-column-visibility-store';
import { isExplorerSortField } from '@brainstrike/app-state/stores/explorer-sort-state-store';
import type { ColumnBounds, TreeTableColumn } from '@brainstrike/ui';
import { FileTreeSizeCell, FileTreeTokensCell, FileTreeTypeCell } from './file-tree-metadata-cells';
import { FileTreeNameCell } from './file-tree-name-cell';
import { FileTreeThreadCell } from './file-tree-thread-cell';
import type { FileTreeRowData } from './optimized-file-tree-model';

/**
 * The public column shape: one hideable metadata column. `id` is narrowed to
 * `ExplorerMetadataColumnId` so consumers iterating
 * `EXPLORER_METADATA_COLUMN_CONFIGS` index the sizing/visibility maps directly
 * instead of re-asserting `id as ExplorerMetadataColumnId` at every call site.
 */
export interface ExplorerMetadataColumnConfig {
  /** Metadata values are numeric or badge-like and read better trailing. */
  align: 'left' | 'right';
  id: ExplorerMetadataColumnId;
  label: string;
}

/**
 * Widened to include the pinned `name` tree column. Internal: only the full
 * `EXPLORER_COLUMN_CONFIGS` list below needs it, and nothing outside this
 * module consumes that list — so this stays unexported rather than becoming a
 * base class consumers can see extended but cannot name.
 */
interface ExplorerColumnConfig extends Omit<ExplorerMetadataColumnConfig, 'id'> {
  id: 'name' | ExplorerMetadataColumnId;
}

/** Every column, name first. Only the metadata slice below is exported. */
const EXPLORER_COLUMN_CONFIGS: readonly ExplorerColumnConfig[] = [
  { align: 'left', id: 'name', label: 'Name' },
  // ADR-0021: rendered only where the active thread's context is published.
  { align: 'left', id: 'thread', label: 'This thread' },
  { align: 'left', id: 'type', label: 'Type' },
  { align: 'right', id: 'tokens', label: 'Tokens' },
  { align: 'right', id: 'size', label: 'Size' },
] as const;

export const EXPLORER_METADATA_COLUMN_CONFIGS: readonly ExplorerMetadataColumnConfig[] =
  EXPLORER_COLUMN_CONFIGS.filter(
    (column): column is ExplorerMetadataColumnConfig => column.id !== 'name'
  );

/**
 * Resize bounds for one metadata column, in the shape `ColumnResizeHandle`
 * wants. Derived from the same map the persisted widths are clamped against,
 * so the panel-level forest header and TreeTable's own header cannot disagree
 * about how far a column may be dragged.
 */
export function getExplorerColumnResizeBounds(columnId: ExplorerMetadataColumnId): ColumnBounds {
  const bounds = EXPLORER_COLUMN_BOUNDS[columnId];
  return {
    defaultWidth: bounds.defaultWidth,
    isPinned: false,
    maxWidth: bounds.maxWidth,
    minWidth: bounds.minWidth,
    resizable: true,
  };
}

/** Shared by the body cells and both header renderers so padding cannot drift. */
export const EXPLORER_METADATA_CELL_CLASS = 'px-2 py-0';
export const EXPLORER_METADATA_HEADER_CLASS = 'h-7 px-2 py-0 font-medium text-[11px]';
export const EXPLORER_NAME_HEADER_CLASS = 'h-7 py-0 pr-2 pl-1.5 font-medium text-[11px]';

function metadataCellClassName(align: ExplorerMetadataColumnConfig['align']): string {
  return align === 'right'
    ? `${EXPLORER_METADATA_CELL_CLASS} text-right`
    : EXPLORER_METADATA_CELL_CLASS;
}

function metadataHeaderContentClassName(align: ExplorerMetadataColumnConfig['align']): string {
  return align === 'right' ? 'justify-end' : '';
}

export interface BuildFileTreeColumnsOptions {
  onSelectionChange: (rowData: FileTreeRowData) => void;
  /**
   * Metadata columns to render, in `EXPLORER_COLUMN_CONFIGS` order. Empty means
   * name-only — either the seam is not mounted or the panel is too narrow.
   */
  visibleMetadataColumnIds: readonly ExplorerMetadataColumnId[];
}

function buildMetadataColumn(
  config: ExplorerMetadataColumnConfig
): TreeTableColumn<FileTreeRowData> {
  const bounds = EXPLORER_COLUMN_BOUNDS[config.id];
  const Cell = {
    size: FileTreeSizeCell,
    thread: FileTreeThreadCell,
    tokens: FileTreeTokensCell,
    type: FileTreeTypeCell,
  }[config.id];
  return {
    cell: ({ node }) => <Cell rowData={node.data} />,
    className: metadataCellClassName(config.align),
    defaultWidth: bounds.defaultWidth,
    header: config.label,
    headerClassName: EXPLORER_METADATA_HEADER_CLASS,
    headerContentClassName: metadataHeaderContentClassName(config.align),
    id: config.id,
    isTreeColumn: false,
    maxWidth: bounds.maxWidth,
    minWidth: bounds.minWidth,
    // "This thread" has no order the tree could sort by.
    sortable: isExplorerSortField(config.id),
  };
}

/**
 * Build the column array. Callers MUST memoize on
 * `visibleMetadataColumnIds` + `onSelectionChange` — the array flows straight
 * into `TreeTableRow`, whose memo is the scroll hot path for every tree
 * surface (docs/agents/ui-conventions.md, row render stability).
 */
export function buildFileTreeColumns({
  onSelectionChange,
  visibleMetadataColumnIds,
}: BuildFileTreeColumnsOptions): TreeTableColumn<FileTreeRowData>[] {
  const visible = new Set<ExplorerMetadataColumnId>(visibleMetadataColumnIds);
  const columns: TreeTableColumn<FileTreeRowData>[] = [
    {
      cell: ({ node, isExpanded }) => (
        <FileTreeNameCell
          isExpanded={isExpanded}
          onSelectionChange={onSelectionChange}
          rowData={node.data}
        />
      ),
      className: '!p-0',
      header: 'Name',
      headerClassName: EXPLORER_NAME_HEADER_CLASS,
      id: 'name',
      // Pinned: the tree column absorbs the remaining width and never resizes.
      resizable: false,
      sortable: true,
    },
  ];
  for (const config of EXPLORER_METADATA_COLUMN_CONFIGS) {
    if (visible.has(config.id)) {
      columns.push(buildMetadataColumn(config));
    }
  }
  return columns;
}
