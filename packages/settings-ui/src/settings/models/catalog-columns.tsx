import type { TreeTableCellProps, TreeTableColumn } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import {
  ActionsCell,
  CapabilitiesCell,
  EnabledCell,
  ModelCell,
  PriceCell,
  TokenCell,
} from './catalog-cells';
import { CatalogModelDetails } from './catalog-model-details';
import type { CatalogNodeData } from './catalog-nodes';
import type { CatalogSortColumn } from './catalog-sections';

export type CatalogWidthTier = 'medium' | 'narrow' | 'wide';

export type CatalogColumnId =
  | 'actions'
  | 'capabilities'
  | 'context'
  | 'enabled'
  | 'maxOutput'
  | 'model'
  | 'price';

export interface CatalogColumnLayout {
  readonly align: 'center' | 'left' | 'right';
  readonly id: CatalogColumnId;
  /** Visible header text; empty for the switch and actions columns. */
  readonly label: string;
  /** Accessible name of the column's sort control. */
  readonly name: string;
  readonly sortColumn: CatalogSortColumn | null;
  /** Fixed width in px; `null` for the flexible Model column (the table-fixed remainder). */
  readonly width: number | null;
}

/** Catalog CONTAINER widths, not viewport widths (design §5, Responsive). */
const WIDE_MIN_WIDTH_PX = 900;
const MEDIUM_MIN_WIDTH_PX = 640;

export function resolveCatalogWidthTier(width: number): CatalogWidthTier {
  if (width >= WIDE_MIN_WIDTH_PX) {
    return 'wide';
  }
  if (width >= MEDIUM_MIN_WIDTH_PX) {
    return 'medium';
  }
  return 'narrow';
}

const ENABLED_COLUMN: CatalogColumnLayout = {
  align: 'center',
  id: 'enabled',
  label: '',
  name: 'Enabled',
  sortColumn: null,
  width: 60,
};
const MODEL_COLUMN: CatalogColumnLayout = {
  align: 'left',
  id: 'model',
  label: 'Model',
  name: 'Model',
  sortColumn: 'name',
  width: null,
};
const CAPABILITIES_COLUMN: CatalogColumnLayout = {
  align: 'left',
  id: 'capabilities',
  label: 'Capabilities',
  name: 'Capabilities',
  sortColumn: null,
  width: 96,
};
const COMPACT_CAPABILITIES_COLUMN: CatalogColumnLayout = {
  ...CAPABILITIES_COLUMN,
  label: 'Caps',
  width: 72,
};
const CONTEXT_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'context',
  label: 'Context',
  name: 'Context',
  sortColumn: 'context',
  width: 80,
};
const MAX_OUTPUT_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'maxOutput',
  label: 'Max out',
  name: 'Max output',
  sortColumn: 'maxOutput',
  width: 84,
};
const PRICE_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'price',
  label: '$ / 1M in · out',
  name: 'Price',
  sortColumn: 'price',
  width: 128,
};
const ACTIONS_COLUMN: CatalogColumnLayout = {
  align: 'right',
  id: 'actions',
  label: '',
  name: 'Actions',
  sortColumn: null,
  width: 88,
};

const COLUMN_LAYOUTS: Record<CatalogWidthTier, readonly CatalogColumnLayout[]> = {
  medium: [
    ENABLED_COLUMN,
    MODEL_COLUMN,
    CAPABILITIES_COLUMN,
    CONTEXT_COLUMN,
    PRICE_COLUMN,
    ACTIONS_COLUMN,
  ],
  narrow: [
    ENABLED_COLUMN,
    MODEL_COLUMN,
    COMPACT_CAPABILITIES_COLUMN,
    CONTEXT_COLUMN,
    ACTIONS_COLUMN,
  ],
  wide: [
    ENABLED_COLUMN,
    MODEL_COLUMN,
    CAPABILITIES_COLUMN,
    CONTEXT_COLUMN,
    MAX_OUTPUT_COLUMN,
    PRICE_COLUMN,
    ACTIONS_COLUMN,
  ],
};

export function getCatalogColumnLayout(tier: CatalogWidthTier): readonly CatalogColumnLayout[] {
  return COLUMN_LAYOUTS[tier];
}

function renderCell(
  id: CatalogColumnId,
  { isExpanded, node }: TreeTableCellProps<CatalogNodeData>
): ReactNode {
  const { row } = node.data;
  switch (id) {
    case 'actions':
      return <ActionsCell isExpanded={isExpanded} row={row} />;
    case 'capabilities':
      return <CapabilitiesCell row={row} />;
    case 'context':
      return <TokenCell label="context window" value={row.contextWindow} />;
    case 'enabled':
      return <EnabledCell row={row} />;
    case 'maxOutput':
      return <TokenCell label="max output" value={row.maxOutputTokens} />;
    case 'model':
      return <ModelCell row={row} />;
    case 'price':
      return <PriceCell row={row} />;
    default: {
      const exhaustive: never = id;
      throw new Error(`Unknown catalog column: ${String(exhaustive)}`);
    }
  }
}

function buildColumns(layout: readonly CatalogColumnLayout[]): TreeTableColumn<CatalogNodeData>[] {
  return layout.map((column, index) => ({
    cell: (props: TreeTableCellProps<CatalogNodeData>) =>
      index === 0 && props.node.data.kind === 'detail' ? (
        <CatalogModelDetails row={props.node.data.row} />
      ) : (
        renderCell(column.id, props)
      ),
    className: 'px-2 py-0',
    // The details row is one cell spanning every column.
    ...(index === 0
      ? {
          colSpan: ({ node }: TreeTableCellProps<CatalogNodeData>) =>
            node.data.kind === 'detail' ? layout.length : 1,
        }
      : {}),
    id: column.id,
    // No tree column: the row's own disclosure (Actions) opens details.
    isTreeColumn: false,
    ...(column.width === null ? {} : { width: column.width }),
  }));
}

/** Module-level, so every tier's column array is identity-stable (TreeGrid row-identity contract). */
const COLUMNS: Record<CatalogWidthTier, TreeTableColumn<CatalogNodeData>[]> = {
  medium: buildColumns(COLUMN_LAYOUTS.medium),
  narrow: buildColumns(COLUMN_LAYOUTS.narrow),
  wide: buildColumns(COLUMN_LAYOUTS.wide),
};

export function getCatalogColumns(tier: CatalogWidthTier): TreeTableColumn<CatalogNodeData>[] {
  return COLUMNS[tier];
}
