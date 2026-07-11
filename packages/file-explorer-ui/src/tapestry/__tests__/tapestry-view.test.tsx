import { createTestActionRegistry } from '@brainstrike/context-actions';
import { TAPESTRY_COLOR_HEX } from '@brainstrike/types';
import { ActionRegistryProvider, TooltipProvider } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, memo, type ReactNode, useMemo, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupedData, TableRowData } from '../../utils/grouping-configs';
import { TapestryView } from '../tapestry-view';
import type { FileTapestry, TapestryRange } from '../types';

const testActionRegistry = createTestActionRegistry().registry;
const TapestryTestProviders = ({ children }: { children: ReactNode }) => (
  <ActionRegistryProvider registry={testActionRegistry}>
    <TooltipProvider>{children}</TooltipProvider>
  </ActionRegistryProvider>
);

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
    onGroupingChange: vi.fn(),
    onGroupSelectAll: vi.fn(),
    onRangesChange: vi.fn(),
    onResetRanges: vi.fn(),
    onScaleChange: vi.fn(),
    onSelectAllOnPage: vi.fn(),
    onSelectionControlsToggle: vi.fn(),
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
    scale: 4,
    showSelectionControls: true,
    totalFiles: files.length,
    ungroupedFiles: files,
    visibleFilesOnPage: tableRows,
    ...overrides,
  };
  return render(
    <TapestryTestProviders>
      <TapestryView {...props} />
    </TapestryTestProviders>
  );
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
    const [scale, setScale] = useState(4);

    const tableRows = useMemo(() => buildTableRows(files), [files]);

    const handleRangesChange = (fileId: string, ranges: TapestryRange[]) => {
      setFiles((prev) =>
        prev.map((file) => (file.id === fileId ? { ...file, selections: ranges } : file))
      );
    };

    // Mirrors preview-panel.tsx's handleResetTapestryRanges: reset clears
    // ranges (no re-seeded default) — a rangeless file is the whole file.
    const handleResetRanges = (fileIds: string[]) => {
      setFiles((prev) =>
        prev.map((file) => (fileIds.includes(file.id) ? { ...file, selections: [] } : file))
      );
    };

    const activeRangesCount = files.reduce(
      (acc, file) => acc + file.selections.filter((range) => range.isActive).length,
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
      <TapestryTestProviders>
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
          onGroupingChange={vi.fn()}
          onGroupSelectAll={vi.fn()}
          onRangesChange={handleRangesChange}
          onResetRanges={handleResetRanges}
          onScaleChange={setScale}
          onSelectAllOnPage={vi.fn()}
          onSelectionControlsToggle={vi.fn()}
          onToggleGroupCollapse={vi.fn()}
          onToggleSelection={vi.fn()}
          pagination={pagination}
          previewSelections={previewSelections}
          scale={scale}
          showSelectionControls={showSelectionControls}
          totalFiles={files.length}
          ungroupedFiles={files}
          visibleFilesOnPage={tableRows}
        />
      </TapestryTestProviders>
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
      fireEvent.click(firstButton);
    });

    const activateButtons = await screen.findAllByRole('button', { name: /activate range/i });
    expect(activateButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('scales the spatial gallery and changes overlap from view options', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const gallery = screen.getByTestId('tapestry-gallery');
    expect(gallery.style.gridTemplateColumns).toContain('184px');
    expect(gallery.style.columnGap).toBe('12px');
    expect(gallery.style.gridAutoRows).toBe('4px');
    expect(gallery.style.rowGap).toBe('4px');

    const scaleInput = screen.getByRole('slider', { name: 'Gallery scale' });
    await act(async () => {
      fireEvent.change(scaleInput, { target: { value: '8' } });
    });
    expect(scaleInput).toHaveValue('8');
    expect(gallery.style.gridTemplateColumns).toContain('256px');
    expect(gallery.style.columnGap).toBe('16px');

    await user.click(screen.getByRole('button', { name: 'View options' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Allow overlapping clips' }));
    await user.click(screen.getByRole('button', { name: 'View options' }));
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Allow overlapping clips' })
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('shares code-lens state between the document context menu and command dock', async () => {
    render(<TapestryHarness count={1} />);

    const track = screen.getByTestId('tapestry-track');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
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
    fireEvent.contextMenu(
      screen.getByRole('button', { name: /inspect or create range in file-0\.ts/i }),
      { clientX: 40, clientY: 200 }
    );
    await user.click(screen.getByRole('menuitem', { name: /disable code lens/i }));

    expect(screen.getByRole('button', { name: 'Toggle code lens' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('commits an exact one-line clip from a document context action', async () => {
    render(<TapestryHarness count={1} />);
    const track = screen.getByTestId('tapestry-track');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
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

    fireEvent.contextMenu(
      screen.getByRole('button', { name: /inspect or create range in file-0\.ts/i }),
      { clientX: 40, clientY: 240 }
    );
    await user.click(screen.getByRole('menuitem', { name: /create clip at line 61/i }));

    expect(
      await screen.findByRole('slider', { name: /selection lines 61 to 61 in file-0\.ts/i })
    ).toBeVisible();
  });

  it('persists a named context-menu color in the rendered clip', async () => {
    render(<TapestryHarness count={1} />);
    const range = screen.getByRole('slider', {
      name: /selection lines 11 to 20 in file-0\.ts/i,
    });

    fireEvent.contextMenu(range);
    await user.click(screen.getByRole('menuitem', { name: /color: green/i }));

    await waitFor(() => {
      expect(range.parentElement?.getAttribute('style')).toContain(TAPESTRY_COLOR_HEX.green);
    });
  });

  it('permits an exact clip on an occupied line only after overlap is enabled', async () => {
    render(<TapestryHarness count={1} />);
    await user.click(screen.getByRole('button', { name: 'View options' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Allow overlapping clips' }));

    const track = screen.getByTestId('tapestry-track');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
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
    fireEvent.contextMenu(
      screen.getByRole('button', { name: /inspect or create range in file-0\.ts/i }),
      { clientX: 40, clientY: 60 }
    );
    const createAction = screen.getByRole('menuitem', { name: /create clip at line 16/i });
    expect(createAction).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(createAction);

    expect(
      await screen.findByRole('slider', { name: /selection lines 16 to 16 in file-0\.ts/i })
    ).toBeVisible();
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
      .filter((s) => s.getAttribute('aria-label')?.startsWith('Selection'));
    const range = ranges[0];
    if (!range) {
      throw new Error('Range slider not found');
    }
    range.focus();

    await act(async () => {
      fireEvent.keyDown(range, { key: 'ArrowDown' });
    });
    expect(range.getAttribute('aria-valuenow')).toBe('12');

    await act(async () => {
      fireEvent.keyDown(range, { key: 'ArrowUp' });
    });
    expect(range.getAttribute('aria-valuenow')).toBe('11');
  });

  it('handles range interactions (drag start)', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const ranges = screen
      .getAllByRole('slider')
      .filter((s) => s.getAttribute('aria-label')?.startsWith('Selection'));
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

    expect(range.getAttribute('aria-valuenow')).toBe('12');

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 104, pointerId: 1 }));
    });
  });

  it('commits the latest queued drag position when pointer-up lands before the next frame', async () => {
    let queuedFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queuedFrame = callback;
      return 17;
    });

    await act(async () => {
      render(<TapestryHarness count={1} />);
    });

    const range = screen.getByRole('slider', { name: /^selection/i });
    await act(async () => {
      fireEvent.pointerDown(range, { button: 0, clientY: 100, pointerId: 1 });
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 104, pointerId: 1 }));
    });

    expect(queuedFrame).toBeTypeOf('function');
    expect(range).toHaveAttribute('aria-valuenow', '11');

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 104, pointerId: 1 }));
    });

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(17);
    expect(range).toHaveAttribute('aria-valuenow', '12');
  });

  it('commits the pointer-up release coordinate after the previous drag frame has rendered', async () => {
    let queuedFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queuedFrame = callback;
      return 23;
    });

    await act(async () => {
      render(<TapestryHarness count={1} />);
    });

    const range = screen.getByRole('slider', { name: /^selection/i });
    fireEvent.pointerDown(range, { button: 0, clientY: 100, pointerId: 1 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 104, pointerId: 1 }));
    act(() => queuedFrame?.(0));
    expect(range).toHaveAttribute('aria-valuenow', '12');

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 108, pointerId: 1 }));
    });

    expect(range).toHaveAttribute('aria-valuenow', '13');
  });

  it('rolls back all applied drag frames when the active pointer is canceled', async () => {
    await act(async () => {
      render(<TapestryHarness count={1} />);
    });

    const range = screen.getByRole('slider', { name: /^selection/i });
    fireEvent.pointerDown(range, { button: 0, clientY: 100, pointerId: 1 });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 104, pointerId: 1 }));
    });
    expect(range).toHaveAttribute('aria-valuenow', '12');

    act(() => {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    });

    expect(range).toHaveAttribute('aria-valuenow', '11');
  });

  it('commits the latest accepted drag position when the window blurs', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 29);

    await act(async () => {
      render(<TapestryHarness count={1} />);
    });

    const range = screen.getByRole('slider', { name: /^selection/i });
    fireEvent.pointerDown(range, { button: 0, clientY: 100, pointerId: 1 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 104, pointerId: 1 }));
    expect(range).toHaveAttribute('aria-valuenow', '11');

    act(() => window.dispatchEvent(new Event('blur')));

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(29);
    expect(range).toHaveAttribute('aria-valuenow', '12');
  });

  it('ends and rolls back a range drag when the active pointer is canceled', async () => {
    await act(async () => {
      render(<TapestryHarness count={1} />);
    });

    const range = screen.getByRole('slider', { name: /^selection/i });

    await act(async () => {
      fireEvent.pointerDown(range, { button: 0, clientY: 100, pointerId: 1 });
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 104, pointerId: 1 }));
    });
    expect(range).toHaveAttribute('aria-valuenow', '12');

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 108, pointerId: 1 }));
    });

    expect(range).toHaveAttribute('aria-valuenow', '11');
  });

  it('discards a queued drag frame when the active pointer is canceled', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 19);

    await act(async () => {
      render(<TapestryHarness count={1} />);
    });

    const range = screen.getByRole('slider', { name: /^selection/i });
    await act(async () => {
      fireEvent.pointerDown(range, { button: 0, clientY: 100, pointerId: 1 });
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 104, pointerId: 1 }));
    });

    expect(range).toHaveAttribute('aria-valuenow', '11');

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    });

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(19);
    expect(range).toHaveAttribute('aria-valuenow', '11');
  });

  it('handles range resizing', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const resizeTop = screen.getAllByTestId('resize-range-top')[0];
    if (!resizeTop) {
      throw new Error('Resize top handle not found');
    }
    const ranges = screen
      .getAllByRole('slider')
      .filter((s) => s.getAttribute('aria-label')?.startsWith('Selection'));
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
    expect(range.getAttribute('aria-valuenow')).toBe('10');

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 96, pointerId: 1 }));
    });

    const resizeBottom = screen.getAllByTestId('resize-range-bottom')[0];
    if (!resizeBottom) {
      throw new Error('Resize bottom handle not found');
    }
    await act(async () => {
      fireEvent.pointerDown(resizeBottom, { clientY: 200, pointerId: 1 });
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 204, pointerId: 1 }));
    });
    expect(range.getAttribute('aria-label')).toMatch(/Selection lines 10 to 21/i);
  });

  it('creates new range on background click', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const minimapBg = document.querySelector('[data-minimap-background="true"]');
    if (!minimapBg) {
      throw new Error('minimap-bg not found');
    }

    await act(async () => {
      const track = screen.getAllByTestId('tapestry-track')[0];
      if (!track) {
        throw new Error('Tapestry track not found');
      }
      vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
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

      fireEvent.pointerDown(minimapBg, { clientX: 10, clientY: 200, pointerId: 1 });
      fireEvent.pointerMove(minimapBg, { clientX: 10, clientY: 206, pointerId: 1 });
    });

    expect(screen.getAllByRole('slider', { name: /^selection/i })).toHaveLength(13);
  });

  it('removes a newly created clip when its pointer is canceled', async () => {
    render(<TapestryHarness count={1} />);
    const minimapBg = document.querySelector('[data-minimap-background="true"]');
    const track = screen.getByTestId('tapestry-track');
    if (!minimapBg) {
      throw new Error('minimap-bg not found');
    }
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
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

    fireEvent.pointerDown(minimapBg, { clientX: 10, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(minimapBg, { clientX: 10, clientY: 206, pointerId: 1 });
    expect(screen.getAllByRole('slider', { name: /^selection/i })).toHaveLength(2);

    act(() => {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    });

    expect(screen.getAllByRole('slider', { name: /^selection/i })).toHaveLength(1);
  });

  it('resets ranges when button is clicked (clears ranges, does not re-seed a default)', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    expect(screen.getAllByRole('slider', { name: /^selection/i })).toHaveLength(12);

    await user.click(screen.getByRole('button', { name: 'View options' }));
    const resetButton = screen.getByRole('menuitem', {
      name: /Clear manual clips on this page/i,
    });
    await act(async () => {
      await user.click(resetButton);
    });

    expect(screen.getAllByText(/file-\d+\.ts/i)).toHaveLength(12);
    // No ranges remain — a rangeless file renders no range sliders, and each
    // minimap shows the whole-file affordance instead.
    expect(screen.queryAllByRole('slider', { name: /^selection/i })).toHaveLength(0);
    expect(screen.getAllByText(/whole file.*click to inspect or drag to select/i)).toHaveLength(12);
  });

  it('prevents range creation on overlap when disabled', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const minimapBg = document.querySelector('[data-minimap-background="true"]');
    if (!minimapBg) {
      throw new Error('minimap-bg not found');
    }

    await act(async () => {
      const track = screen.getAllByTestId('tapestry-track')[0];
      if (!track) {
        throw new Error('Tapestry track not found');
      }
      vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
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

      fireEvent.pointerDown(minimapBg, { clientX: 10, clientY: 60, pointerId: 1 });
      fireEvent.pointerMove(minimapBg, { clientX: 10, clientY: 66, pointerId: 1 });
    });

    expect(screen.getAllByRole('slider', { name: /^selection/i })).toHaveLength(12);
  });

  it('numbers visible manual clips without gaps from hidden Search-managed clips', () => {
    const file = buildFile(0);
    const searchRange: TapestryRange = {
      ...file.selections[0]!,
      endLine: 8,
      id: 'search-range',
      origin: 'search',
      startLine: 1,
    };
    const manualRange: TapestryRange = {
      ...file.selections[0]!,
      endLine: 20,
      id: 'manual-range',
      startLine: 10,
    };
    const mixedFile = { ...file, selections: [searchRange, manualRange] };

    renderTapestryView({
      activeRangesCount: 2,
      totalFiles: 1,
      ungroupedFiles: [mixedFile],
      visibleFilesOnPage: buildTableRows([mixedFile]),
    });

    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.queryByText('#2')).toBeNull();
  });

  it('uses the document-wide code lens instead of a range-bound tooltip', async () => {
    await act(async () => {
      render(<TapestryHarness />);
    });

    const range = screen
      .getAllByRole('slider')
      .find((s) => s.getAttribute('aria-label')?.startsWith('Selection'));

    if (!range) {
      throw new Error('Range slider not found');
    }

    await act(async () => {
      fireEvent.mouseEnter(range);
    });

    expect(screen.queryByText(/Lines 10-20/i)).not.toBeInTheDocument();

    const track = screen.getAllByTestId('tapestry-track')[0];
    if (!track) {
      throw new Error('Tapestry track not found');
    }
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
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

    await act(async () => {
      fireEvent.pointerMove(track, { clientX: 300, clientY: 238, pointerType: 'mouse' });
    });

    const lens = screen.getByTestId('tapestry-lens');
    expect(lens).toHaveTextContent('Line 60');
    expect(lens.querySelector('[data-lens-active="true"]')).toHaveTextContent('line 59');

    await act(async () => {
      fireEvent.pointerLeave(track);
    });

    expect(screen.queryByTestId('tapestry-lens')).not.toBeInTheDocument();
  });

  it('keeps only one pinned precision lens open across the gallery', () => {
    renderTapestryView();

    const tracks = screen.getAllByTestId('tapestry-track');
    const backgrounds = screen.getAllByRole('button', { name: /inspect or create range in/i });
    for (const track of tracks) {
      vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
        bottom: 120,
        height: 120,
        left: 0,
        right: 100,
        toJSON: () => {},
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      } as DOMRect);
    }

    fireEvent.keyDown(backgrounds[0]!, { key: 'Enter' });
    expect(
      screen.getByRole('dialog', { name: /precision line selector for file-0\.ts/i })
    ).toBeVisible();

    fireEvent.keyDown(backgrounds[1]!, { key: 'Enter' });

    expect(screen.getAllByRole('dialog', { name: /precision line selector/i })).toHaveLength(1);
    expect(
      screen.getByRole('dialog', { name: /precision line selector for file-1\.ts/i })
    ).toBeVisible();
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
      <TapestryTestProviders>
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
          onGroupingChange={vi.fn()}
          onGroupSelectAll={vi.fn()}
          onRangesChange={vi.fn()}
          onResetRanges={vi.fn()}
          onScaleChange={vi.fn()}
          onSelectAllOnPage={onSelectAllOnPage}
          onSelectionControlsToggle={vi.fn()}
          onToggleGroupCollapse={vi.fn()}
          onToggleSelection={vi.fn()}
          pagination={{
            currentPage: 0,
            onPageChange: vi.fn(),
            totalItems: files.length,
            totalPages: 1,
          }}
          previewSelections={new Set(tableRows.map((row) => row.compositeKey))}
          scale={4}
          showSelectionControls={true}
          totalFiles={files.length}
          ungroupedFiles={files}
          visibleFilesOnPage={tableRows}
        />
      </TapestryTestProviders>
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
    expect(screen.getByTestId('tapestry-group-header')).toHaveClass('@container', 'min-w-0');
    expect(screen.getByText('Source files')).toHaveClass('truncate');
    expect(screen.getByTestId('tapestry-group-token-count')).toHaveClass('@max-[360px]:hidden');
    expect(screen.getByTestId('tapestry-group-size')).toHaveClass('@max-[440px]:hidden');
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
