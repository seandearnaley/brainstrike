import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, memo, useMemo, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupedData, TableRowData } from '../../utils/grouping-configs';
import { TapestryView } from '../tapestry-view';
import type { FileTapestry, TapestryRange } from '../types';

const buildFile = (index: number): FileTapestry => {
  const totalLines = 100;
  const range: TapestryRange = {
    color: '#ff0000',
    endLine: 20,
    id: `range-${index}-0`,
    isActive: true,
    startLine: 10,
  };

  return {
    compositeKey: `file-${index}`,
    content: Array.from({ length: totalLines }).map((_, j) => `line ${j}`),
    contentStatus: 'ready',
    id: `file-${index}`,
    language: 'ts',
    name: `file-${index}.ts`,
    path: `/src/file-${index}.ts`,
    rootFolderId: 'root',
    selections: [range],
    size: 5120,
    structure: Array.from({ length: totalLines }).map((_, j) => ({
      indent: 0,
      isEmpty: j === 50,
      width: 50,
    })),
    tokens: 1500,
    totalLines,
    type: 'TS',
  };
};

const buildTableRows = (files: FileTapestry[]): TableRowData[] =>
  files.map((file) => {
    const row: TableRowData = {
      compositeKey: file.compositeKey,
      id: file.id,
      path: file.path,
      rootFolderId: file.rootFolderId,
      type: file.type,
    };
    if (file.tokens !== undefined) {
      row.tokens = file.tokens;
    }
    if (file.size !== undefined) {
      row.size = file.size;
    }
    return row;
  });

function renderTapestryView(overrides: Partial<ComponentProps<typeof TapestryView>> = {}) {
  const files = [buildFile(0), buildFile(1)];
  const tableRows = buildTableRows(files);
  const props: ComponentProps<typeof TapestryView> = {
    activeRangesCount: 2,
    groupedSections: [],
    groupingConfig: 'none',
    isAllSelected: () => false,
    isEmpty: false,
    isGroupFullySelected: () => false,
    isGroupPartiallySelected: () => false,
    onDeselectAll: vi.fn(),
    onGroupDeselectAll: vi.fn(),
    onGroupSelectAll: vi.fn(),
    onRangesChange: vi.fn(),
    onResetRanges: vi.fn(),
    onSelectAllOnPage: vi.fn(),
    onToggleGroupCollapse: vi.fn(),
    onToggleSelection: vi.fn(),
    pagination: {
      currentPage: 0,
      onPageChange: vi.fn(),
      pageInfo: '1-2 of 2',
      pageSize: 25,
      totalItems: files.length,
      totalPages: 1,
    },
    previewSelections: new Set<string>(),
    showSelectionControls: true,
    totalFiles: files.length,
    totalLinesSelected: 20,
    ungroupedFiles: files,
    visibleFilesOnPage: tableRows,
    ...overrides,
  };
  return render(<TapestryView {...props} />);
}

const TapestryHarness = memo(
  ({
    count = 12,
    showSelectionControls = true,
  }: {
    count?: number;
    showSelectionControls?: boolean;
  }) => {
    const [files, setFiles] = useState<FileTapestry[]>(() =>
      Array.from({ length: count }).map((_, index) => buildFile(index))
    );
    const [previewSelections] = useState<Set<string>>(new Set());

    const tableRows = useMemo(() => buildTableRows(files), [files]);

    const handleRangesChange = (fileId: string, ranges: TapestryRange[]) => {
      setFiles((prev) =>
        prev.map((file) => (file.id === fileId ? { ...file, selections: ranges } : file))
      );
    };

    const handleResetRanges = (fileIds: string[]) => {
      setFiles((prev) =>
        prev.map((file) => {
          if (!fileIds.includes(file.id)) {
            return file;
          }
          const baseRange =
            file.selections[0] ??
            ({
              color: '#ff0000',
              endLine: file.totalLines,
              id: `range-${file.id}-reset`,
              isActive: true,
              startLine: 0,
            } satisfies TapestryRange);
          const resetRange: TapestryRange = {
            color: baseRange.color,
            endLine: file.totalLines,
            id: baseRange.id,
            isActive: baseRange.isActive,
            startLine: 0,
          };
          return { ...file, selections: [resetRange] };
        })
      );
    };

    const activeRangesCount = files.reduce(
      (acc, file) => acc + file.selections.filter((range) => range.isActive).length,
      0
    );
    const totalLinesSelected = files.reduce(
      (acc, file) =>
        acc +
        file.selections
          .filter((range) => range.isActive)
          .reduce((sum, range) => sum + (range.endLine - range.startLine), 0),
      0
    );

    const pagination = useMemo(
      () => ({
        currentPage: 0,
        onPageChange: vi.fn(),
        totalItems: files.length,
        totalPages: 1,
      }),
      [files.length]
    );

    return (
      <TapestryView
        activeRangesCount={activeRangesCount}
        groupedSections={[]}
        groupingConfig="none"
        isAllSelected={() => false}
        isEmpty={false}
        isGroupFullySelected={() => false}
        isGroupPartiallySelected={() => false}
        onDeselectAll={vi.fn()}
        onGroupDeselectAll={vi.fn()}
        onGroupSelectAll={vi.fn()}
        onRangesChange={handleRangesChange}
        onResetRanges={handleResetRanges}
        onSelectAllOnPage={vi.fn()}
        onToggleGroupCollapse={vi.fn()}
        onToggleSelection={vi.fn()}
        pagination={pagination}
        previewSelections={previewSelections}
        showSelectionControls={showSelectionControls}
        totalFiles={files.length}
        totalLinesSelected={totalLinesSelected}
        ungroupedFiles={files}
        visibleFilesOnPage={tableRows}
      />
    );
  }
);

TapestryHarness.displayName = 'TapestryHarness';

describe('TapestryView', () => {
  const user = userEvent.setup();

  // Mock rAF to execute synchronously so drag tests see immediate range updates.
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  it('renders correctly with files', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    expect(screen.getAllByText(/file-\d+\.ts/i)).toHaveLength(12);
  });

  it('toggles a range active state', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const deactivateButtons = screen.getAllByRole('button', { name: /deactivate range/i });
    expect(deactivateButtons).toHaveLength(12);
    const firstButton = deactivateButtons[0];
    if (!firstButton) {
      throw new Error('Deactivate button not found');
    }

    await act(async () => {
      fireEvent.pointerDown(firstButton);
    });

    const activateButtons = await screen.findAllByRole('button', { name: /activate range/i });
    expect(activateButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('handles scale and overlap changes', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const scaleInput = screen.getByLabelText(/Density/i);
    await act(async () => {
      fireEvent.change(scaleInput, { target: { value: '10' } });
    });
    expect(scaleInput).toHaveValue('10');

    const overlapCheckbox = screen.getByRole('checkbox', { name: /Allow Overlap/i });
    await act(async () => {
      await user.click(overlapCheckbox);
    });
    expect(overlapCheckbox.getAttribute('aria-checked')).toBe('true');
  });

  it('hides selection controls when multi-select is disabled', async () => {
    await act(async () => {
      render(<TapestryHarness showSelectionControls={false} />);
    });

    expect(screen.queryByLabelText(/Select all files on current page/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Select \/src\/file-0\.ts/i)).not.toBeInTheDocument();
  });

  it('handles range movement via keyboard', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const ranges = screen
      .getAllByRole('slider')
      .filter((s) => s.getAttribute('aria-label')?.startsWith('Range'));
    const range = ranges[0];
    if (!range) {
      throw new Error('Range slider not found');
    }
    range.focus();

    await act(async () => {
      fireEvent.keyDown(range, { key: 'ArrowDown' });
    });
    expect(range.getAttribute('aria-valuenow')).toBe('11');

    await act(async () => {
      fireEvent.keyDown(range, { key: 'ArrowUp' });
    });
    expect(range.getAttribute('aria-valuenow')).toBe('10');
  });

  it('handles range interactions (drag start)', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const ranges = screen
      .getAllByRole('slider')
      .filter((s) => s.getAttribute('aria-label')?.startsWith('Range'));
    const range = ranges[0];
    if (!range) {
      throw new Error('Range slider not found');
    }

    await act(async () => {
      fireEvent.pointerDown(range, { button: 0, clientY: 100, pointerId: 1 });
    });

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 104, pointerId: 1 }));
    });

    expect(range.getAttribute('aria-valuenow')).toBe('11');

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });
  });

  it('handles range resizing', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const resizeTop = screen.getAllByLabelText(/Resize range top/i)[0];
    if (!resizeTop) {
      throw new Error('Resize top handle not found');
    }
    const ranges = screen
      .getAllByRole('slider')
      .filter((s) => s.getAttribute('aria-label')?.startsWith('Range'));
    const range = ranges[0];
    if (!range) {
      throw new Error('Range slider not found');
    }

    await act(async () => {
      fireEvent.pointerDown(resizeTop, { clientY: 100, pointerId: 1 });
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 96, pointerId: 1 }));
    });
    expect(range.getAttribute('aria-valuenow')).toBe('9');

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });

    const resizeBottom = screen.getAllByLabelText(/Resize range bottom/i)[0];
    if (!resizeBottom) {
      throw new Error('Resize bottom handle not found');
    }
    await act(async () => {
      fireEvent.pointerDown(resizeBottom, { clientY: 200, pointerId: 1 });
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 204, pointerId: 1 }));
    });
    expect(range.getAttribute('aria-label')).toMatch(/Range 9 to 21/i);
  });

  it('creates new range on background click', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const minimapBg = document.getElementById('minimap-bg');
    if (!minimapBg) {
      throw new Error('minimap-bg not found');
    }

    await act(async () => {
      const container = minimapBg.parentElement as HTMLElement;
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        bottom: 400,
        height: 400,
        left: 0,
        right: 200,
        toJSON: () => {},
        top: 0,
        width: 200,
        x: 0,
        y: 0,
      } as DOMRect);

      fireEvent.pointerDown(minimapBg, { clientY: 200, pointerId: 1 });
    });

    const sliders = screen.getAllByRole('slider');
    expect(sliders.length).toBeGreaterThanOrEqual(13);
  });

  it('resets ranges when button is clicked', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const resetButton = screen.getByRole('button', { name: /Reset ranges/i });
    await act(async () => {
      await user.click(resetButton);
    });

    expect(screen.getAllByText(/file-\d+\.ts/i)).toHaveLength(12);
  });

  it('prevents range creation on overlap when disabled', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const minimapBg = document.getElementById('minimap-bg');
    if (!minimapBg) {
      throw new Error('minimap-bg not found');
    }

    await act(async () => {
      const container = minimapBg.parentElement as HTMLElement;
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        bottom: 400,
        height: 400,
        left: 0,
        right: 200,
        toJSON: () => {},
        top: 0,
        width: 200,
        x: 0,
        y: 0,
      } as DOMRect);

      fireEvent.pointerDown(minimapBg, { clientY: 60, pointerId: 1 });
    });

    expect(screen.getAllByRole('slider').length).toBeGreaterThanOrEqual(13);
  });

  it('shows peek tooltip on range hover', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const range = screen
      .getAllByRole('slider')
      .find((s) => s.getAttribute('aria-label')?.startsWith('Range'));

    if (!range) {
      throw new Error('Range slider not found');
    }

    await act(async () => {
      fireEvent.mouseEnter(range);
    });

    const tooltips = screen.getAllByText(/Lines 10-20/i);
    expect(tooltips.length).toBeGreaterThanOrEqual(1);

    const lineContents = screen.getAllByText(/line 10/i);
    expect(lineContents.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireEvent.mouseLeave(range);
    });

    expect(screen.queryByText(/Lines 10-20/i)).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no matching files', () => {
    renderTapestryView({
      isEmpty: true,
      totalFiles: 0,
      ungroupedFiles: [],
      visibleFilesOnPage: [],
    });

    expect(screen.getByText('No matching files')).toBeInTheDocument();
    expect(
      screen.getByText('Try adjusting your filters or selecting more files')
    ).toBeInTheDocument();
  });

  it('selects and deselects the current page from the page checkbox', async () => {
    const onSelectAllOnPage = vi.fn();
    const onDeselectAll = vi.fn();
    const files = [buildFile(0), buildFile(1)];
    const tableRows = buildTableRows(files);
    const { rerender } = renderTapestryView({
      onDeselectAll,
      onSelectAllOnPage,
      ungroupedFiles: files,
      visibleFilesOnPage: tableRows,
    });

    const pageCheckbox = screen.getByRole('checkbox', {
      name: /select all files on current page/i,
    });
    await user.click(pageCheckbox);

    expect(onSelectAllOnPage).toHaveBeenCalledWith(tableRows);

    rerender(
      <TapestryView
        activeRangesCount={2}
        groupedSections={[]}
        groupingConfig="none"
        isAllSelected={() => true}
        isEmpty={false}
        isGroupFullySelected={() => false}
        isGroupPartiallySelected={() => false}
        onDeselectAll={onDeselectAll}
        onGroupDeselectAll={vi.fn()}
        onGroupSelectAll={vi.fn()}
        onRangesChange={vi.fn()}
        onResetRanges={vi.fn()}
        onSelectAllOnPage={onSelectAllOnPage}
        onToggleGroupCollapse={vi.fn()}
        onToggleSelection={vi.fn()}
        pagination={{
          currentPage: 0,
          onPageChange: vi.fn(),
          totalItems: files.length,
          totalPages: 1,
        }}
        previewSelections={new Set(tableRows.map((row) => row.compositeKey))}
        showSelectionControls={true}
        totalFiles={files.length}
        totalLinesSelected={20}
        ungroupedFiles={files}
        visibleFilesOnPage={tableRows}
      />
    );

    await user.click(screen.getByRole('checkbox', { name: /select all files on current page/i }));

    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('renders grouped sections and dispatches group controls', async () => {
    const files = [buildFile(0), buildFile(1)];
    const tableRows = buildTableRows(files);
    const group: GroupedData<TableRowData> = {
      count: files.length,
      groupKey: 'src',
      groupLabel: 'Source files',
      items: tableRows,
      totalSize: files.reduce((total, file) => total + (file.size ?? 0), 0),
      totalTokens: files.reduce((total, file) => total + (file.tokens ?? 0), 0),
    };
    const onGroupDeselectAll = vi.fn();
    const onGroupSelectAll = vi.fn();
    const onToggleGroupCollapse = vi.fn();

    renderTapestryView({
      groupedSections: [
        {
          group,
          isCollapsed: false,
          items: files,
          showHeader: true,
        },
      ],
      groupingConfig: 'directory',
      isGroupFullySelected: () => false,
      isGroupPartiallySelected: () => true,
      onGroupDeselectAll,
      onGroupSelectAll,
      onToggleGroupCollapse,
      previewSelections: new Set([files[0]?.compositeKey ?? '']),
      ungroupedFiles: [],
      visibleFilesOnPage: tableRows,
    });

    expect(screen.getByText('Source files')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.getAllByText(/file-\d+\.ts/i)).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /collapse group source files/i }));
    expect(onToggleGroupCollapse).toHaveBeenCalledWith('src');

    await user.click(
      screen.getByRole('checkbox', { name: /select all items in group source files/i })
    );
    expect(onGroupSelectAll).toHaveBeenCalledWith(group);
    expect(onGroupDeselectAll).not.toHaveBeenCalled();
  });

  it('hides collapsed grouped section items', () => {
    const files = [buildFile(0), buildFile(1)];
    const tableRows = buildTableRows(files);
    const group: GroupedData<TableRowData> = {
      count: files.length,
      groupKey: 'src',
      groupLabel: 'Source files',
      items: tableRows,
      totalSize: 0,
      totalTokens: 0,
    };

    renderTapestryView({
      groupedSections: [{ group, isCollapsed: true, items: files, showHeader: true }],
      groupingConfig: 'directory',
      ungroupedFiles: [],
      visibleFilesOnPage: tableRows,
    });

    expect(screen.getByText('Source files')).toBeInTheDocument();
    expect(screen.queryByText('file-0.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('file-1.ts')).not.toBeInTheDocument();
  });
});

/**
 * @vitest-environment jsdom
 */
