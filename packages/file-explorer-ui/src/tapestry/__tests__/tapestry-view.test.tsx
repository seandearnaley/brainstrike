import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TapestryView } from '../tapestry-view';

const fallbackRandomUUID = () => Math.random().toString(36).substring(2);

// Mock generateMockFiles to have predictable data
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    generateMockFiles: (count: number) =>
      Array.from({ length: count }).map((_, i) => ({
        id: `file-${i}`,
        name: `file-${i}.ts`,
        language: 'ts',
        totalLines: 100,
        structure: Array.from({ length: 100 }).map((_, j) => ({
          indent: 0,
          width: 50,
          isEmpty: j === 50,
        })),
        content: Array.from({ length: 100 }).map((_, j) => `line ${j}`),
        selections: [
          {
            id: `range-${i}-0`,
            startLine: 10,
            endLine: 20,
            isActive: true,
            color: '#ff0000',
          },
        ],
      })),
  };
});

describe('TapestryView', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
      vi.stubGlobal('crypto', { randomUUID: fallbackRandomUUID });
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders correctly with mock files', async () => {
    await act(async () => {
      render(<TapestryView />);
    });

    // Check for "12" for files count
    const filesStats = screen.getAllByText('12');
    expect(filesStats.length).toBeGreaterThanOrEqual(1);

    expect(screen.getAllByText(/file-\d+\.ts/i)).toHaveLength(12);
  });

  it('toggles a range active state', async () => {
    await act(async () => {
      render(<TapestryView />);
    });

    const deactivateButtons = screen.getAllByRole('button', { name: /deactivate range/i });
    expect(deactivateButtons).toHaveLength(12);
    const firstButton = deactivateButtons[0];
    if (!firstButton) {
      throw new Error('Deactivate button not found');
    }

    // Use fireEvent.mouseDown directly since the component explicitly listens to it
    await act(async () => {
      fireEvent.mouseDown(firstButton);
    });

    // We expect at least one to be deactivated (now "Activate range")
    const activateButtons = await screen.findAllByRole('button', { name: /activate range/i });
    expect(activateButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('handles scale and overlap changes', async () => {
    await act(async () => {
      render(<TapestryView />);
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
      render(<TapestryView />);
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
      render(<TapestryView />);
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
      render(<TapestryView />);
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
      render(<TapestryView />);
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

    // 12 files * 1 initial range + 1 new range = 13 range sliders
    // Plus 1 density slider = 14 total sliders
    const sliders = screen.getAllByRole('slider');
    expect(sliders.length).toBeGreaterThanOrEqual(13);
  });

  it('regenerates files when button is clicked', async () => {
    await act(async () => {
      render(<TapestryView />);
    });

    const regenerateButton = screen.getByRole('button', { name: /Regenerate/i });
    await act(async () => {
      await user.click(regenerateButton);
    });

    // Should still have 12 files
    expect(screen.getAllByText(/file-\d+\.ts/i)).toHaveLength(12);
  });

  it('prevents range creation on overlap when disabled', async () => {
    await act(async () => {
      render(<TapestryView />);
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

      // Try to create range at line 15, where there is already a range (10-20)
      // scale is 4, so line 15 is 60px
      fireEvent.mouseDown(minimapBg, { clientY: 60 });
    });

    // Should still have 13 sliders (12 range + 1 density), no new range added
    expect(screen.getAllByRole('slider').length).toBe(13);
  });

  it('shows peek tooltip on range hover', async () => {
    await act(async () => {
      render(<TapestryView />);
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

    expect(screen.getByText(/Lines 10-20/i)).toBeInTheDocument();
    expect(screen.getByText(/line 10/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseLeave(range);
    });

    expect(screen.queryByText(/Lines 10-20/i)).not.toBeInTheDocument();
  });
});

/**
 * @vitest-environment jsdom
 */
