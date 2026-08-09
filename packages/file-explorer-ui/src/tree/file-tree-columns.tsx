/**
 * Column definitions for the Explorer tree grid (BST-1208).
 *
 * ONE source of truth for the four columns, shared by three renderers: the
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
import type { ColumnBounds, TreeTableColumn } from '@brainstrike/ui';
import { FileTreeSizeCell, FileTreeTokensCell, FileTreeTypeCell } from './file-tree-metadata-cells';
import { FileTreeNameCell } from './file-tree-name-cell';
import type { FileTreeRowData } from './optimized-file-tree-model';

export type ExplorerColumnId = 'name' | ExplorerMetadataColumnId;

export interface ExplorerColumnConfig {
  /** Metadata values are numeric or badge-like and read better trailing. */
  align: 'left' | 'right';
  id: ExplorerColumnId;
  label: string;
}

export const EXPLORER_COLUMN_CONFIGS: readonly ExplorerColumnConfig[] = [
  { align: 'left', id: 'name', label: 'Name' },
  { align: 'left', id: 'type', label: 'Type' },
  { align: 'right', id: 'tokens', label: 'Tokens' },
  { align: 'right', id: 'size', label: 'Size' },
] as const;

export const EXPLORER_METADATA_COLUMN_CONFIGS: readonly ExplorerColumnConfig[] =
  EXPLORER_COLUMN_CONFIGS.filter(
    (column): column is ExplorerColumnConfig & { id: ExplorerMetadataColumnId } =>
      column.id !== 'name'
  );

export function getExplorerColumnLabel(columnId: ExplorerColumnId): string {
  const config = EXPLORER_COLUMN_CONFIGS.find((column) => column.id === columnId);
  if (!config) {
    throw new Error(`Unknown Explorer column id "${columnId}"`);
  }
  return config.label;
}

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

function metadataCellClassName(align: ExplorerColumnConfig['align']): string {
  return align === 'right'
    ? `${EXPLORER_METADATA_CELL_CLASS} text-right`
    : EXPLORER_METADATA_CELL_CLASS;
}

function metadataHeaderContentClassName(align: ExplorerColumnConfig['align']): string {
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
  config: ExplorerColumnConfig & { id: ExplorerMetadataColumnId }
): TreeTableColumn<FileTreeRowData> {
  const bounds = EXPLORER_COLUMN_BOUNDS[config.id];
  const Cell =
    config.id === 'type'
      ? FileTreeTypeCell
      : config.id === 'tokens'
        ? FileTreeTokensCell
        : FileTreeSizeCell;
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
    },
  ];
  for (const config of EXPLORER_METADATA_COLUMN_CONFIGS) {
    if (visible.has(config.id as ExplorerMetadataColumnId)) {
      columns.push(
        buildMetadataColumn(config as ExplorerColumnConfig & { id: ExplorerMetadataColumnId })
      );
    }
  }
  return columns;
}
