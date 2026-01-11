import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import type { TableRowData } from './utils/grouping-configs';

export interface ColumnConfig {
  id: keyof ColumnVisibility;
  label: string;
  accessor: keyof TableRowData | 'checkbox';
  canHide: boolean;
  defaultVisible: boolean;
}

export const COLUMN_CONFIGS: ColumnConfig[] = [
  {
    id: 'checkbox',
    label: 'Selection',
    accessor: 'checkbox',
    canHide: false,
    defaultVisible: true,
  },
  {
    id: 'rootFolderId',
    label: 'Folder',
    accessor: 'rootFolderId',
    canHide: true,
    defaultVisible: true,
  },
  { id: 'path', label: 'File Path', accessor: 'path', canHide: false, defaultVisible: true },
  { id: 'type', label: 'Type', accessor: 'type', canHide: true, defaultVisible: true },
  { id: 'tokens', label: 'Tokens', accessor: 'tokens', canHide: true, defaultVisible: true },
  { id: 'size', label: 'Size', accessor: 'size', canHide: true, defaultVisible: true },
];

const DEFAULT_COLUMN_VISIBILITY = {
  checkbox: true,
  rootFolderId: true,
  path: true,
  type: true,
  tokens: true,
  size: true,
} satisfies ColumnVisibility;

export const createDefaultColumnVisibility = (): ColumnVisibility => ({
  ...DEFAULT_COLUMN_VISIBILITY,
});

export const resolveColumnVisibility = (
  stored: Partial<ColumnVisibility> | null | undefined
): ColumnVisibility => ({
  ...createDefaultColumnVisibility(),
  ...stored,
  checkbox: true,
  path: true,
});
