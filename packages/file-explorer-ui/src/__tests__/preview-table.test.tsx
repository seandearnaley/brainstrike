import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ColumnVisibility } from '../hooks/use-preview-panel-persistence';
import { PreviewTable } from '../preview-table';
import type { GroupedData, TableRowData } from '../utils/grouping-configs';

const DEFAULT_COLUMN_VISIBILITY: ColumnVisibility = {
  checkbox: true,
  rootFolderId: true,
  path: true,
  type: true,
  tokens: true,
  size: true,
};

const FILE_ONE: TableRowData = {
  id: '1',
  rootFolderId: 'workspace',
  path: 'src/file-one.ts',
  type: 'ts',
  tokens: 125,
  size: 1024,
  compositeKey: 'workspace:src/file-one.ts',
};

const FILE_TWO: TableRowData = {
  id: '2',
  rootFolderId: 'workspace',
  path: 'src/file-two.tsx',
  type: 'tsx',
  tokens: 250,
  size: 2048,
  compositeKey: 'workspace:src/file-two.tsx',
};

const DEFAULT_GROUP: GroupedData<TableRowData> = {
  groupKey: 'src',
  groupLabel: 'src',
  items: [FILE_ONE, FILE_TWO],
  count: 2,
  totalTokens: 375,
  totalSize: 3072,
};

interface PreviewTableTestOverrides {
  collapsedGroups?: Set<string>;
  groupedData?: GroupedData<TableRowData>[];
  pagination?: { startIndex: number; endIndex: number };
  previewSelections?: Set<string>;
  isGroupFullySelected?: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected?: (group: GroupedData<TableRowData>) => boolean;
  handleGroupSelectAll?: (group: GroupedData<TableRowData>) => void;
  handleGroupDeselectAll?: (group: GroupedData<TableRowData>) => void;
  toggleGroupCollapse?: (groupKey: string | number) => void;
}

function renderGroupedPreviewTable(overrides: PreviewTableTestOverrides = {}) {
  const props = {
    columnVisibility: DEFAULT_COLUMN_VISIBILITY,
    sortField: 'path' as const,
    sortDirection: 'asc' as const,
    groupingConfig: 'directory',
    groupedData: overrides.groupedData ?? [DEFAULT_GROUP],
    currentPageData: [],
    collapsedGroups: overrides.collapsedGroups ?? new Set<string>(),
    previewSelections: overrides.previewSelections ?? new Set<string>(),
    visibleFilesOnPage: [FILE_ONE, FILE_TWO],
    onSort: vi.fn(),
    onToggleSelection: vi.fn(),
    onSelectAllOnPage: vi.fn(),
    onDeselectAll: vi.fn(),
    isAllSelected: vi.fn(() => false),
    onFileClick: vi.fn(),
    toggleGroupCollapse: overrides.toggleGroupCollapse ?? vi.fn(),
    isGroupFullySelected: overrides.isGroupFullySelected ?? (() => false),
    isGroupPartiallySelected: overrides.isGroupPartiallySelected ?? (() => false),
    handleGroupSelectAll: overrides.handleGroupSelectAll ?? vi.fn(),
    handleGroupDeselectAll: overrides.handleGroupDeselectAll ?? vi.fn(),
    pagination: overrides.pagination ?? { startIndex: 0, endIndex: 20 },
  };

  render(<PreviewTable {...props} />);
  return props;
}

describe('PreviewTable grouped mode', () => {
  it('renders grouped rows in a grid with accessible group toggle state', () => {
    renderGroupedPreviewTable();

    expect(screen.getByRole('grid', { name: 'Context explorer table' })).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /collapse group src/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles group collapse via button click and keeps toggle focusable', () => {
    const toggleGroupCollapse = vi.fn();
    renderGroupedPreviewTable({ toggleGroupCollapse });

    const toggle = screen.getByRole('button', { name: /collapse group src/i });
    fireEvent.click(toggle);

    toggle.focus();
    expect(toggle).toHaveFocus();

    expect(toggleGroupCollapse).toHaveBeenCalledTimes(1);
    expect(toggleGroupCollapse).toHaveBeenCalledWith('src');
  });

  it('uses group checkbox action for select flow', () => {
    const handleGroupSelectAll = vi.fn();
    const handleGroupDeselectAll = vi.fn();

    renderGroupedPreviewTable({
      handleGroupSelectAll,
      handleGroupDeselectAll,
      isGroupFullySelected: () => false,
      isGroupPartiallySelected: () => false,
    });

    const groupCheckbox = screen.getByLabelText('Select all files in group src');
    fireEvent.click(groupCheckbox);

    expect(handleGroupSelectAll).toHaveBeenCalledTimes(1);
    expect(handleGroupSelectAll).toHaveBeenCalledWith(DEFAULT_GROUP);
    expect(handleGroupDeselectAll).not.toHaveBeenCalled();
  });

  it('uses group checkbox action for deselect flow when group is fully selected', () => {
    const handleGroupSelectAll = vi.fn();
    const handleGroupDeselectAll = vi.fn();

    renderGroupedPreviewTable({
      handleGroupSelectAll,
      handleGroupDeselectAll,
      isGroupFullySelected: () => true,
      isGroupPartiallySelected: () => false,
    });

    const checkedGroupCheckbox = screen.getByLabelText('Select all files in group src');
    fireEvent.click(checkedGroupCheckbox);

    expect(handleGroupDeselectAll).toHaveBeenCalledTimes(1);
    expect(handleGroupDeselectAll).toHaveBeenCalledWith(DEFAULT_GROUP);
    expect(handleGroupSelectAll).not.toHaveBeenCalled();
  });

  it('preserves grouped page slicing semantics when page starts inside group items', () => {
    renderGroupedPreviewTable({
      pagination: { startIndex: 1, endIndex: 2 },
    });

    expect(screen.queryByRole('button', { name: /collapse group src/i })).not.toBeInTheDocument();
    expect(screen.getByText('file-one.ts')).toBeInTheDocument();
  });

  it('uses the latest sort callback after rerender', () => {
    const onSortInitial = vi.fn();
    const onSortUpdated = vi.fn();
    const sharedProps = {
      columnVisibility: DEFAULT_COLUMN_VISIBILITY,
      sortField: 'path' as const,
      sortDirection: 'asc' as const,
      groupingConfig: 'directory',
      groupedData: [DEFAULT_GROUP],
      currentPageData: [] as TableRowData[],
      collapsedGroups: new Set<string>(),
      previewSelections: new Set<string>(),
      visibleFilesOnPage: [FILE_ONE, FILE_TWO],
      onToggleSelection: vi.fn(),
      onSelectAllOnPage: vi.fn(),
      onDeselectAll: vi.fn(),
      isAllSelected: vi.fn(() => false),
      onFileClick: vi.fn(),
      toggleGroupCollapse: vi.fn(),
      isGroupFullySelected: () => false,
      isGroupPartiallySelected: () => false,
      handleGroupSelectAll: vi.fn(),
      handleGroupDeselectAll: vi.fn(),
      pagination: { startIndex: 0, endIndex: 20 },
    };
    const { rerender } = render(<PreviewTable {...sharedProps} onSort={onSortInitial} />);

    rerender(<PreviewTable {...sharedProps} onSort={onSortUpdated} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by File Path' }));

    expect(onSortUpdated).toHaveBeenCalledWith('path');
    expect(onSortInitial).not.toHaveBeenCalled();
  });

  it('reflects latest preview selections after rerender', () => {
    const sharedProps = {
      columnVisibility: DEFAULT_COLUMN_VISIBILITY,
      sortField: 'path' as const,
      sortDirection: 'asc' as const,
      groupingConfig: 'directory',
      groupedData: [DEFAULT_GROUP],
      currentPageData: [] as TableRowData[],
      collapsedGroups: new Set<string>(),
      visibleFilesOnPage: [FILE_ONE, FILE_TWO],
      onSort: vi.fn(),
      onToggleSelection: vi.fn(),
      onSelectAllOnPage: vi.fn(),
      onDeselectAll: vi.fn(),
      isAllSelected: vi.fn(() => false),
      onFileClick: vi.fn(),
      toggleGroupCollapse: vi.fn(),
      isGroupFullySelected: () => false,
      isGroupPartiallySelected: () => false,
      handleGroupSelectAll: vi.fn(),
      handleGroupDeselectAll: vi.fn(),
      pagination: { startIndex: 0, endIndex: 20 },
    };

    const { rerender } = render(
      <PreviewTable {...sharedProps} previewSelections={new Set<string>()} />
    );

    expect(screen.getByLabelText('Select src/file-one.ts')).not.toBeChecked();

    rerender(
      <PreviewTable {...sharedProps} previewSelections={new Set<string>([FILE_ONE.compositeKey])} />
    );

    expect(screen.getByLabelText('Select src/file-one.ts')).toBeChecked();
  });

  it('preserves pagination semantics when skipping large groups before the page window', () => {
    const largeGroupItems = Array.from({ length: 100 }, (_, index) => ({
      ...FILE_ONE,
      id: `large-${index}`,
      path: `src/large-file-${index}.ts`,
      compositeKey: `workspace:src/large-file-${index}.ts`,
    }));
    const largeGroup: GroupedData<TableRowData> = {
      groupKey: 'large',
      groupLabel: 'large',
      items: largeGroupItems,
      count: largeGroupItems.length,
      totalTokens: largeGroupItems.reduce((sum, item) => sum + (item.tokens ?? 0), 0),
      totalSize: largeGroupItems.reduce((sum, item) => sum + (item.size ?? 0), 0),
    };
    const trailingFile: TableRowData = {
      ...FILE_TWO,
      id: 'trailing-file',
      path: 'tail/trailing-file.tsx',
      compositeKey: 'workspace:tail/trailing-file.tsx',
    };
    const trailingGroup: GroupedData<TableRowData> = {
      groupKey: 'tail',
      groupLabel: 'tail',
      items: [trailingFile],
      count: 1,
      totalTokens: trailingFile.tokens ?? 0,
      totalSize: trailingFile.size ?? 0,
    };

    renderGroupedPreviewTable({
      groupedData: [largeGroup, trailingGroup],
      pagination: { startIndex: 101, endIndex: 103 },
    });

    expect(screen.getByRole('button', { name: /collapse group tail/i })).toBeInTheDocument();
    expect(screen.getByText('trailing-file.tsx')).toBeInTheDocument();
    expect(screen.queryByText('large-file-0.ts')).not.toBeInTheDocument();
  });
});
