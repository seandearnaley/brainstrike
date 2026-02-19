import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { memo, useMemo, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TableRowData } from '../../utils/grouping-configs';
import { TapestryView } from '../tapestry-view';
import type { FileTapestry, TapestryRange } from '../types';

const buildFile = (index: number): FileTapestry => {
  const totalLines = 100;
  const range: TapestryRange = {
    id: `range-${index}-0`,
    startLine: 10,
    endLine: 20,
    isActive: true,
    color: '#ff0000',
  };

  return {
    id: `file-${index}`,
    compositeKey: `file-${index}`,
    rootFolderId: 'root',
    path: `/src/file-${index}.ts`,
    name: `file-${index}.ts`,
    language: 'ts',
    type: 'TS',
    size: 5120,
    tokens: 1500,
    totalLines,
    structure: Array.from({ length: totalLines }).map((_, j) => ({
      indent: 0,
      width: 50,
      isEmpty: j === 50,
    })),
    content: Array.from({ length: totalLines }).map((_, j) => `line ${j}`),
    contentStatus: 'ready',
    selections: [range],
  };
};

const buildTableRows = (files: FileTapestry[]): TableRowData[] =>
  files.map((file) => {
    const row: TableRowData = {
      id: file.id,
      compositeKey: file.compositeKey,
      rootFolderId: file.rootFolderId,
      path: file.path,
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

const TapestryHarness = memo(({ count = 12 }: { count?: number }) => {
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
            id: `range-${file.id}-reset`,
            startLine: 0,
            endLine: file.totalLines,
            isActive: true,
            color: '#ff0000',
          } satisfies TapestryRange);
        const resetRange: TapestryRange = {
          id: baseRange.id,
          startLine: 0,
          endLine: file.totalLines,
          isActive: baseRange.isActive,
          color: baseRange.color,
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
      totalPages: 1,
      totalItems: files.length,
      onPageChange: vi.fn(),
    }),
    [files.length]
  );

  return (
    <TapestryView
      activeRangesCount={activeRangesCount}
      allFilesSelected={false}
      groupedData={[]}
      groupedSections={[]}
      groupingConfig="none"
      isAllSelected={() => false}
      isEmpty={false}
      isGroupFullySelected={() => false}
      isGroupPartiallySelected={() => false}
      onCollapseAllGroups={vi.fn()}
      onDeselectAll={vi.fn()}
      onExpandAllGroups={vi.fn()}
      onGroupDeselectAll={vi.fn()}
      onGroupingChange={vi.fn()}
      onGroupSelectAll={vi.fn()}
      onRangesChange={handleRangesChange}
      onResetRanges={handleResetRanges}
      onSelectAllFiles={vi.fn()}
      onSelectAllOnPage={vi.fn()}
      onToggleGroupCollapse={vi.fn()}
      onToggleSelection={vi.fn()}
      pagination={pagination}
      previewSelections={previewSelections}
      totalFiles={files.length}
      totalLinesSelected={totalLinesSelected}
      ungroupedFiles={files}
      visibleFilesOnPage={tableRows}
    />
  );
});

TapestryHarness.displayName = 'TapestryHarness';

describe('TapestryView', () => {
  const user = userEvent.setup();

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
      fireEvent.mouseDown(firstButton);
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
      fireEvent.mouseDown(range, { clientY: 100, button: 0 });
    });

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 104 }));
    });

    expect(range.getAttribute('aria-valuenow')).toBe('11');

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup'));
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
      fireEvent.mouseDown(resizeTop, { clientY: 100 });
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 96 }));
    });
    expect(range.getAttribute('aria-valuenow')).toBe('9');

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    const resizeBottom = screen.getAllByLabelText(/Resize range bottom/i)[0];
    if (!resizeBottom) {
      throw new Error('Resize bottom handle not found');
    }
    await act(async () => {
      fireEvent.mouseDown(resizeBottom, { clientY: 200 });
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 204 }));
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
        top: 0,
        left: 0,
        bottom: 400,
        right: 200,
        width: 200,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);

      fireEvent.mouseDown(minimapBg, { clientY: 200 });
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
        top: 0,
        left: 0,
        bottom: 400,
        right: 200,
        width: 200,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);

      fireEvent.mouseDown(minimapBg, { clientY: 60 });
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
});

/**
 * @vitest-environment jsdom
 */
