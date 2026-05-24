import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewTable } from '../preview/preview-table';
import type { ColumnVisibility } from '../preview/use-preview-panel-persistence';
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
  columnVisibility?: ColumnVisibility;
  currentPageData?: TableRowData[];
  groupedData?: GroupedData<TableRowData>[];
  groupingConfig?: string;
  handleGroupDeselectAll?: (group: GroupedData<TableRowData>) => void;
  handleGroupSelectAll?: (group: GroupedData<TableRowData>) => void;
  isGroupFullySelected?: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected?: (group: GroupedData<TableRowData>) => boolean;
  pagination?: { startIndex: number; endIndex: number };
  previewSelections?: Set<string>;
  toggleGroupCollapse?: (groupKey: string | number) => void;
}

function renderGroupedPreviewTable(overrides: PreviewTableTestOverrides = {}) {
  const props = {
    columnVisibility: overrides.columnVisibility ?? DEFAULT_COLUMN_VISIBILITY,
    sortField: 'path' as const,
    sortDirection: 'asc' as const,
    groupingConfig: overrides.groupingConfig ?? 'directory',
    groupedData: overrides.groupedData ?? [DEFAULT_GROUP],
    currentPageData: overrides.currentPageData ?? [],
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

const DESKTOP_ROOT_FILE: TableRowData = {
  id: 'desktop-root',
  rootFolderId: '/Users/me/BrainStrike',
  path: '/Users/me/BrainStrike/README.md',
  type: 'md',
  tokens: 10,
  size: 256,
  compositeKey: '/Users/me/BrainStrike:/Users/me/BrainStrike/README.md',
};

const DESKTOP_NESTED_FILE: TableRowData = {
  id: 'desktop-nested',
  rootFolderId: '/Users/me/BrainStrike',
  path: '/Users/me/BrainStrike/source/index.ts',
  type: 'ts',
  tokens: 20,
  size: 512,
  compositeKey: '/Users/me/BrainStrike:/Users/me/BrainStrike/source/index.ts',
};

function renderUngroupedPreviewTable(overrides: Partial<PreviewTableTestOverrides> = {}) {
  const props = {
    columnVisibility: overrides.columnVisibility ?? DEFAULT_COLUMN_VISIBILITY,
    sortField: 'path' as const,
    sortDirection: 'asc' as const,
    groupingConfig: 'none',
    groupedData: overrides.groupedData ?? [],
    currentPageData: [FILE_ONE, FILE_TWO],
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
  it('does not carry dead Tailwind width classes on grouped cells/headers (BST-549)', () => {
    // After PR #1034 the TreeTable `<colgroup>` + `table-fixed` layout owns
    // column widths. Per-cell `w-24` / `w-44` classes are inert and
    // misleading. This test fails until the dead classes are removed from
    // the grouped column builders in preview-table.tsx.
    renderGroupedPreviewTable();

    const grid = screen.getByRole('treegrid', { name: 'Context explorer table' });
    const cellsWithDeadWidth = grid.querySelectorAll('[class*="w-24"], [class*="w-44"]');
    expect(cellsWithDeadWidth).toHaveLength(0);
  });

  it('renders grouped rows with tree hierarchy semantics', () => {
    renderGroupedPreviewTable();

    expect(screen.getByRole('treegrid', { name: 'Context explorer table' })).toBeInTheDocument();

    const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
    const firstItemRow = screen.getByText('file-one.ts').closest('tr');

    expect(groupRow).toHaveAttribute('aria-level', '1');
    expect(groupRow).toHaveAttribute('aria-expanded', 'true');
    expect(firstItemRow).toHaveAttribute('aria-level', '2');
  });

  it('toggles group collapse via tree expand control and keeps toggle focusable', () => {
    const toggleGroupCollapse = vi.fn();
    renderGroupedPreviewTable({ toggleGroupCollapse });

    const toggle = screen.getByRole('button', { name: 'Collapse' });
    fireEvent.click(toggle);

    toggle.focus();
    expect(toggle).toHaveFocus();

    expect(toggleGroupCollapse).toHaveBeenCalledTimes(1);
    expect(toggleGroupCollapse).toHaveBeenCalledWith('src');
  });

  it('preserves numeric group keys when toggling collapse', () => {
    const toggleGroupCollapse = vi.fn();
    const numericGroup: GroupedData<TableRowData> = {
      ...DEFAULT_GROUP,
      groupKey: 42,
      groupLabel: '42',
    };
    renderGroupedPreviewTable({
      groupedData: [numericGroup],
      toggleGroupCollapse,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));

    expect(toggleGroupCollapse).toHaveBeenCalledTimes(1);
    expect(toggleGroupCollapse).toHaveBeenCalledWith(42);
  });

  it('supports keyboard-driven collapse on grouped rows', () => {
    const toggleGroupCollapse = vi.fn();
    renderGroupedPreviewTable({ toggleGroupCollapse });

    const tree = screen.getByRole('treegrid', { name: 'Context explorer table' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });

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

    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(screen.getByText('file-one.ts')).toBeInTheDocument();
  });

  it('selects the full grouped dataset from the header checkbox, not only the visible page slice', () => {
    const thirdFile: TableRowData = {
      ...FILE_TWO,
      id: '3',
      path: 'src/file-three.ts',
      compositeKey: 'workspace:src/file-three.ts',
    };
    const handleSelectAll = vi.fn();

    render(
      <PreviewTable
        collapsedGroups={new Set<string>()}
        columnVisibility={DEFAULT_COLUMN_VISIBILITY}
        currentPageData={[]}
        groupedData={[
          {
            ...DEFAULT_GROUP,
            items: [FILE_ONE, FILE_TWO, thirdFile],
            count: 3,
          },
        ]}
        groupingConfig="directory"
        handleGroupDeselectAll={vi.fn()}
        handleGroupSelectAll={vi.fn()}
        isAllSelected={() => false}
        isGroupFullySelected={() => false}
        isGroupPartiallySelected={() => false}
        onDeselectAll={vi.fn()}
        onFileClick={vi.fn()}
        onSelectAllOnPage={handleSelectAll}
        onSort={vi.fn()}
        onToggleSelection={vi.fn()}
        pagination={{ startIndex: 0, endIndex: 2 }}
        previewSelections={new Set<string>()}
        sortDirection="asc"
        sortField="path"
        toggleGroupCollapse={vi.fn()}
        visibleFilesOnPage={[FILE_ONE]}
      />
    );

    fireEvent.click(screen.getByLabelText('Select all files in grouped results'));

    expect(handleSelectAll).toHaveBeenCalledWith([FILE_ONE, FILE_TWO, thirdFile]);
  });

  it('labels the grouped header checkbox to match grouped select-all behavior', () => {
    renderGroupedPreviewTable();

    expect(screen.getByLabelText('Select all files in grouped results')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select all files on current page')).not.toBeInTheDocument();
  });

  it('applies the tree-column header inset to the active grouped data column', () => {
    renderGroupedPreviewTable({
      columnVisibility: {
        checkbox: true,
        rootFolderId: false,
        path: true,
        type: true,
        tokens: true,
        size: true,
      },
    });

    expect(screen.getByText('File Path').closest('th')).toHaveClass('pl-[38px]');
    expect(screen.getByText('Type').closest('th')).not.toHaveClass('pl-[38px]');
  });

  it('moves the tree-column header inset when a different grouped column becomes primary', () => {
    renderGroupedPreviewTable();

    expect(screen.getByText('File Path').closest('th')).toHaveClass('pl-[38px]');
    expect(screen.getByText('Folder').closest('th')).not.toHaveClass('pl-[38px]');
  });

  it('uses the folder column as the grouped tree column for non-folder grouping when folder is visible', () => {
    renderGroupedPreviewTable({
      groupingConfig: 'sizeSteps',
    });

    expect(screen.getByText('Folder').closest('th')).toHaveClass('pl-[38px]');
    expect(screen.getByText('File Path').closest('th')).not.toHaveClass('pl-[38px]');
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

  it('updates grouped item checkbox state after deselecting a checked row', () => {
    function PreviewTableSelectionHarness() {
      const [previewSelections, setPreviewSelections] = useState<Set<string>>(
        new Set<string>([FILE_ONE.compositeKey])
      );

      return (
        <PreviewTable
          collapsedGroups={new Set<string>()}
          columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          currentPageData={[]}
          groupedData={[DEFAULT_GROUP]}
          groupingConfig="directory"
          handleGroupDeselectAll={vi.fn()}
          handleGroupSelectAll={vi.fn()}
          isAllSelected={() => false}
          isGroupFullySelected={() => false}
          isGroupPartiallySelected={() => false}
          onDeselectAll={vi.fn()}
          onFileClick={vi.fn()}
          onSelectAllOnPage={vi.fn()}
          onSort={vi.fn()}
          onToggleSelection={(compositeKey, checked) => {
            setPreviewSelections((previous) => {
              const next = new Set(previous);
              if (checked) {
                next.add(compositeKey);
              } else {
                next.delete(compositeKey);
              }
              return next;
            });
          }}
          pagination={{ startIndex: 0, endIndex: 20 }}
          previewSelections={previewSelections}
          sortDirection="asc"
          sortField="path"
          toggleGroupCollapse={vi.fn()}
          visibleFilesOnPage={[FILE_ONE, FILE_TWO]}
        />
      );
    }

    render(<PreviewTableSelectionHarness />);

    const fileOneCheckbox = screen.getByLabelText('Select src/file-one.ts');
    expect(fileOneCheckbox).toBeChecked();

    fireEvent.click(fileOneCheckbox);

    expect(fileOneCheckbox).not.toBeChecked();
  });

  it('updates grouped item checkbox state after selecting a group and then deselecting one row', () => {
    function GroupSelectionHarness() {
      const [previewSelections, setPreviewSelections] = useState<Set<string>>(new Set<string>());

      const handleSelectionChange = (compositeKey: string, checked: boolean) => {
        setPreviewSelections((previous) => {
          const next = new Set(previous);
          if (checked) {
            next.add(compositeKey);
          } else {
            next.delete(compositeKey);
          }
          return next;
        });
      };

      return (
        <PreviewTable
          collapsedGroups={new Set<string>()}
          columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          currentPageData={[]}
          groupedData={[DEFAULT_GROUP]}
          groupingConfig="directory"
          handleGroupDeselectAll={(group) => {
            setPreviewSelections((previous) => {
              const next = new Set(previous);
              for (const item of group.items) {
                next.delete(item.compositeKey);
              }
              return next;
            });
          }}
          handleGroupSelectAll={(group) => {
            setPreviewSelections((previous) => {
              const next = new Set(previous);
              for (const item of group.items) {
                next.add(item.compositeKey);
              }
              return next;
            });
          }}
          isAllSelected={() => false}
          isGroupFullySelected={(group) =>
            group.items.every((item) => previewSelections.has(item.compositeKey))
          }
          isGroupPartiallySelected={(group) =>
            group.items.some((item) => previewSelections.has(item.compositeKey)) &&
            !group.items.every((item) => previewSelections.has(item.compositeKey))
          }
          onDeselectAll={vi.fn()}
          onFileClick={vi.fn()}
          onSelectAllOnPage={vi.fn()}
          onSort={vi.fn()}
          onToggleSelection={handleSelectionChange}
          pagination={{ startIndex: 0, endIndex: 20 }}
          previewSelections={previewSelections}
          sortDirection="asc"
          sortField="path"
          toggleGroupCollapse={vi.fn()}
          visibleFilesOnPage={[FILE_ONE, FILE_TWO]}
        />
      );
    }

    render(<GroupSelectionHarness />);

    const groupCheckbox = screen.getByLabelText('Select all files in group src');
    const fileOneCheckbox = screen.getByLabelText('Select src/file-one.ts');
    const fileTwoCheckbox = screen.getByLabelText('Select src/file-two.tsx');

    fireEvent.click(groupCheckbox);

    expect(fileOneCheckbox).toBeChecked();
    expect(fileTwoCheckbox).toBeChecked();

    fireEvent.click(fileOneCheckbox);

    expect(fileOneCheckbox).not.toBeChecked();
    expect(fileTwoCheckbox).toBeChecked();
    expect(groupCheckbox).toBePartiallyChecked();
  });

  describe('group row column placement', () => {
    // Regression tests for the "crushed group status line" bug:
    // GroupHeaderSummary was rendering ALL summary data (label + count + tokens + KB)
    // inside the narrow primary column cell (e.g. 176px rootFolderId), causing truncation.
    // Fix: distribute aggregate values across their respective columns.

    it('renders group total tokens in the tokens column cell, not in the primary column', () => {
      // With DEFAULT_COLUMN_VISIBILITY (all visible), primary = path (first in GROUP_COLUMN_ORDER).
      // Column order: checkbox(0), rootFolderId(1), path(2), type(3), tokens(4), size(5).
      renderGroupedPreviewTable();

      const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
      expect(groupRow).not.toBeNull();

      const cells = within(groupRow!).getAllByRole('gridcell');
      // DEFAULT_GROUP totalTokens=375 → formatTokenCount(375)='375'
      expect(within(cells[4]!).getByText('375')).toBeInTheDocument();
    });

    it('renders group total size in the size column cell, not in the primary column', () => {
      renderGroupedPreviewTable();

      const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
      const cells = within(groupRow!).getAllByRole('gridcell');
      // DEFAULT_GROUP totalSize=3072 → '3.0 KB'
      expect(within(cells[5]!).getByText('3.0 KB')).toBeInTheDocument();
    });

    it('does not render token count or size in the primary column for group rows', () => {
      renderGroupedPreviewTable();

      const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
      const cells = within(groupRow!).getAllByRole('gridcell');

      // path (index 2) is primary — should contain label and count, but NOT token/size values
      expect(within(cells[2]!).queryByText('375')).not.toBeInTheDocument();
      expect(within(cells[2]!).queryByText('3.0 KB')).not.toBeInTheDocument();
    });

    it('still renders group label and file count in the primary column', () => {
      renderGroupedPreviewTable();

      const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
      const cells = within(groupRow!).getAllByRole('gridcell');

      expect(within(cells[2]!).getByText('src')).toBeInTheDocument();
      expect(within(cells[2]!).getByTitle('2 files')).toBeInTheDocument();
    });

    it('renders non-folder grouping labels in the folder column when that column is visible', () => {
      const sizeGroup: GroupedData<TableRowData> = {
        ...DEFAULT_GROUP,
        groupKey: 'Small (< 100)',
        groupLabel: 'Small (< 100)',
        items: [
          {
            ...FILE_ONE,
            tokens: 54,
            size: 200,
            path: 'mcp.config.json',
            compositeKey: 'workspace:mcp.config.json',
            type: 'json',
          },
        ],
        count: 1,
        totalTokens: 54,
        totalSize: 200,
      };

      renderGroupedPreviewTable({
        groupedData: [sizeGroup],
        groupingConfig: 'sizeSteps',
      });

      const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
      const cells = within(groupRow!).getAllByRole('gridcell');

      expect(cells).toHaveLength(5);
      expect(cells[1]).toHaveAttribute('colspan', '2');
      expect(within(cells[1]!).getByText('Small (< 100)')).toBeInTheDocument();
      expect(within(cells[1]!).getByTitle('1 files')).toBeInTheDocument();
    });

    it('renders group label in the tokens column when tokens is the only visible column', () => {
      // When only the tokens column is visible, it becomes the primary column.
      // The group label should be shown there rather than a bare number.
      renderGroupedPreviewTable({
        columnVisibility: {
          checkbox: false,
          rootFolderId: false,
          path: false,
          type: false,
          tokens: true,
          size: false,
        },
      });

      const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
      const cells = within(groupRow!).getAllByRole('gridcell');
      // tokens is primary → shows GroupHeaderSummary (label + count)
      expect(within(cells[0]!).getByText('src')).toBeInTheDocument();
    });

    it('renders group total size in size column when tokens and size are visible but others hidden', () => {
      // primary = tokens (first in GROUP_COLUMN_ORDER that is visible)
      renderGroupedPreviewTable({
        columnVisibility: {
          checkbox: false,
          rootFolderId: false,
          path: false,
          type: false,
          tokens: true,
          size: true,
        },
      });

      const groupRow = screen.getByRole('button', { name: 'Collapse' }).closest('tr');
      const cells = within(groupRow!).getAllByRole('gridcell');
      // tokens(0) = primary → label+count; size(1) → '3.0 KB'
      expect(within(cells[0]!).getByText('src')).toBeInTheDocument();
      expect(within(cells[1]!).getByText('3.0 KB')).toBeInTheDocument();
    });
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

    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(screen.getByText('trailing-file.tsx')).toBeInTheDocument();
    expect(screen.queryByText('large-file-0.ts')).not.toBeInTheDocument();
  });
});

describe('PreviewTable file path display', () => {
  it('shows the root folder name instead of "." for desktop root files', () => {
    render(
      <PreviewTable
        collapsedGroups={new Set<string>()}
        columnVisibility={DEFAULT_COLUMN_VISIBILITY}
        currentPageData={[DESKTOP_ROOT_FILE]}
        groupedData={[]}
        groupingConfig="none"
        handleGroupDeselectAll={vi.fn()}
        handleGroupSelectAll={vi.fn()}
        isAllSelected={() => false}
        isGroupFullySelected={() => false}
        isGroupPartiallySelected={() => false}
        onDeselectAll={vi.fn()}
        onFileClick={vi.fn()}
        onSelectAllOnPage={vi.fn()}
        onSort={vi.fn()}
        onToggleSelection={vi.fn()}
        pagination={{ startIndex: 0, endIndex: 20 }}
        previewSelections={new Set<string>()}
        sortDirection="asc"
        sortField="path"
        toggleGroupCollapse={vi.fn()}
        visibleFilesOnPage={[DESKTOP_ROOT_FILE]}
      />
    );

    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('BrainStrike')).toBeInTheDocument();
    expect(screen.queryByText('.')).not.toBeInTheDocument();
  });

  it('prefixes nested desktop file paths with the root folder name', () => {
    render(
      <PreviewTable
        collapsedGroups={new Set<string>()}
        columnVisibility={DEFAULT_COLUMN_VISIBILITY}
        currentPageData={[DESKTOP_NESTED_FILE]}
        groupedData={[]}
        groupingConfig="none"
        handleGroupDeselectAll={vi.fn()}
        handleGroupSelectAll={vi.fn()}
        isAllSelected={() => false}
        isGroupFullySelected={() => false}
        isGroupPartiallySelected={() => false}
        onDeselectAll={vi.fn()}
        onFileClick={vi.fn()}
        onSelectAllOnPage={vi.fn()}
        onSort={vi.fn()}
        onToggleSelection={vi.fn()}
        pagination={{ startIndex: 0, endIndex: 20 }}
        previewSelections={new Set<string>()}
        sortDirection="asc"
        sortField="path"
        toggleGroupCollapse={vi.fn()}
        visibleFilesOnPage={[DESKTOP_NESTED_FILE]}
      />
    );

    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('BrainStrike/source')).toBeInTheDocument();
    expect(screen.queryByText('source')).not.toBeInTheDocument();
  });
});

describe('PreviewTable ungrouped mode', () => {
  it('keeps the checkbox header and body cells on the same compact width contract', () => {
    renderUngroupedPreviewTable();

    expect(screen.getByLabelText('Select all files on current page').closest('th')).toHaveClass(
      'w-8',
      'px-0'
    );
    expect(screen.getByLabelText('Select src/file-one.ts').closest('td')).toHaveClass(
      'w-8',
      'px-0'
    );
  });
});

describe('PreviewTable readiness signal', () => {
  const FILE_WITHOUT_SIZE: TableRowData = {
    id: '3',
    rootFolderId: 'workspace',
    path: 'src/loading.ts',
    type: 'ts',
    tokens: 100,
    compositeKey: 'workspace:src/loading.ts',
  };

  function renderUngroupedWithCurrentPageData(currentPageData: TableRowData[]) {
    return render(
      <PreviewTable
        collapsedGroups={new Set<string>()}
        columnVisibility={DEFAULT_COLUMN_VISIBILITY}
        currentPageData={currentPageData}
        groupedData={[]}
        groupingConfig="none"
        handleGroupDeselectAll={vi.fn()}
        handleGroupSelectAll={vi.fn()}
        isAllSelected={() => false}
        isGroupFullySelected={() => false}
        isGroupPartiallySelected={() => false}
        onDeselectAll={vi.fn()}
        onFileClick={vi.fn()}
        onSelectAllOnPage={vi.fn()}
        onSort={vi.fn()}
        onToggleSelection={vi.fn()}
        pagination={{ startIndex: 0, endIndex: 20 }}
        previewSelections={new Set<string>()}
        sortDirection="asc"
        sortField="path"
        toggleGroupCollapse={vi.fn()}
        visibleFilesOnPage={currentPageData}
      />
    );
  }

  it('reports data-rows-ready="true" in ungrouped mode when every visible row has a resolved size', () => {
    renderUngroupedPreviewTable();
    expect(screen.getByTestId('preview-table')).toHaveAttribute('data-rows-ready', 'true');
  });

  it('reports data-rows-ready="false" in ungrouped mode while any visible row size is still resolving', () => {
    renderUngroupedWithCurrentPageData([FILE_ONE, FILE_WITHOUT_SIZE]);
    expect(screen.getByTestId('preview-table')).toHaveAttribute('data-rows-ready', 'false');
  });

  it('reports data-rows-ready="false" in ungrouped mode when there are no rows to inspect (pre-selection state)', () => {
    renderUngroupedWithCurrentPageData([]);
    expect(screen.getByTestId('preview-table')).toHaveAttribute('data-rows-ready', 'false');
  });

  it('reports data-rows-ready="true" in grouped mode when every row in currentPageData has a resolved size', () => {
    renderGroupedPreviewTable({ currentPageData: [FILE_ONE, FILE_TWO] });
    expect(screen.getByTestId('preview-table')).toHaveAttribute('data-rows-ready', 'true');
  });

  it('reports data-rows-ready="false" in grouped mode while any row in currentPageData is missing a size', () => {
    renderGroupedPreviewTable({ currentPageData: [FILE_ONE, FILE_WITHOUT_SIZE] });
    expect(screen.getByTestId('preview-table')).toHaveAttribute('data-rows-ready', 'false');
  });

  it('reports data-rows-ready="false" in grouped mode when currentPageData is empty (pre-selection state)', () => {
    renderGroupedPreviewTable();
    expect(screen.getByTestId('preview-table')).toHaveAttribute('data-rows-ready', 'false');
  });
});
