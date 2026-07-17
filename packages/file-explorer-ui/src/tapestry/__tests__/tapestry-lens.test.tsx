import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TapestryLens } from '../tapestry-lens';
import type { FileTapestry } from '../types';

const file: FileTapestry = {
  compositeKey: 'root:src/example.ts',
  content: Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`),
  contentStatus: 'ready',
  id: 'example-file',
  language: 'typescript',
  name: 'example.ts',
  path: 'src/example.ts',
  rootFolderId: 'root',
  selections: [],
  structure: [],
  totalLines: 40,
  type: 'file',
};

const StatefulPinnedLens = () => {
  const [lineIndex, setLineIndex] = useState(20);
  return (
    <TapestryLens
      file={file}
      mode="pinned"
      onNavigate={setLineIndex}
      position={{ clientX: 100, clientY: 100, lineIndex, trackHeight: 400, trackTop: 0 }}
    />
  );
};

describe('TapestryLens', () => {
  it('reclaims focus after the pointer event that pins the precision selector finishes', () => {
    let focusFrame: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        focusFrame = callback;
        return 27;
      });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    render(
      <>
        <button type="button">Background action</button>
        <TapestryLens
          file={file}
          mode="pinned"
          position={{ clientX: 100, clientY: 100, lineIndex: 20, trackHeight: 400, trackTop: 0 }}
        />
      </>
    );

    screen.getByRole('button', { name: 'Background action' }).focus();
    expect(screen.getByRole('button', { name: 'Background action' })).toHaveFocus();
    expect(focusFrame).toBeTypeOf('function');

    act(() => focusFrame?.(0));

    expect(
      screen.getByRole('dialog', { name: 'Precision line selector for example.ts' })
    ).toHaveFocus();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it('keeps precision navigation available while a selectable row owns focus', () => {
    const onNavigate = vi.fn();
    render(
      <TapestryLens
        file={file}
        mode="pinned"
        onNavigate={onNavigate}
        position={{ clientX: 100, clientY: 100, lineIndex: 20, trackHeight: 400, trackTop: 0 }}
      />
    );

    const activeRow = screen.getByRole('button', { name: /create clip from line 21/i });
    activeRow.focus();
    fireEvent.keyDown(activeRow, { key: 'End' });

    expect(onNavigate).toHaveBeenCalledWith(39);
  });

  it('keeps focus in the precision selector when navigation replaces the focused row', () => {
    render(<StatefulPinnedLens />);
    const activeRow = screen.getByRole('button', { name: /create clip from line 21/i });
    activeRow.focus();

    fireEvent.keyDown(activeRow, { key: 'End' });

    expect(screen.getByText('Line 40')).toBeVisible();
    expect(
      screen.getByRole('dialog', { name: 'Precision line selector for example.ts' })
    ).toHaveFocus();
  });

  it.each([
    ['ArrowUp', 19],
    ['ArrowDown', 21],
    ['PageUp', 10],
    ['PageDown', 30],
    ['Home', 0],
    ['End', 39],
  ])('maps %s to the expected precision line', (key, expectedLine) => {
    const onNavigate = vi.fn();
    render(
      <TapestryLens
        file={file}
        mode="pinned"
        onNavigate={onNavigate}
        position={{ clientX: 100, clientY: 100, lineIndex: 20, trackHeight: 400, trackTop: 0 }}
      />
    );

    fireEvent.keyDown(
      screen.getByRole('dialog', { name: 'Precision line selector for example.ts' }),
      { key }
    );

    expect(onNavigate).toHaveBeenCalledWith(expectedLine);
  });

  it.each(['Enter', ' '])('creates the active exact line with %s', (key) => {
    const onCreateRange = vi.fn();
    render(
      <TapestryLens
        file={file}
        mode="pinned"
        onCreateRange={onCreateRange}
        position={{ clientX: 100, clientY: 100, lineIndex: 20, trackHeight: 400, trackTop: 0 }}
      />
    );

    fireEvent.keyDown(
      screen.getByRole('dialog', { name: 'Precision line selector for example.ts' }),
      { key }
    );

    expect(onCreateRange).toHaveBeenCalledWith(20);
  });

  it('places the roving glass beside the pointer and clamps it inside the viewport', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800, writable: true });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
      writable: true,
    });

    try {
      const { rerender } = render(
        <TapestryLens
          file={file}
          position={{ clientX: 20, clientY: 0, lineIndex: 20, trackHeight: 400, trackTop: 0 }}
        />
      );

      expect(screen.getByTestId('tapestry-lens')).toHaveStyle({ left: '40px', top: '12px' });
      expect(screen.getByTestId('tapestry-lens-pointer')).toHaveClass('-left-1');

      rerender(
        <TapestryLens
          file={file}
          position={{ clientX: 780, clientY: 600, lineIndex: 20, trackHeight: 400, trackTop: 0 }}
        />
      );

      expect(screen.getByTestId('tapestry-lens')).toHaveStyle({ left: '456px', top: '356px' });
      expect(screen.getByTestId('tapestry-lens-pointer')).toHaveClass('-right-1');
    } finally {
      if (originalWidth) {
        Object.defineProperty(window, 'innerWidth', originalWidth);
      }
      if (originalHeight) {
        Object.defineProperty(window, 'innerHeight', originalHeight);
      }
    }
  });

  it('keeps pinned rows scrollable when the viewport is shorter than the preferred lens height', () => {
    render(
      <TapestryLens
        file={file}
        mode="pinned"
        position={{ clientX: 100, clientY: 100, lineIndex: 20, trackHeight: 400, trackTop: 0 }}
      />
    );

    expect(
      screen.getByRole('dialog', { name: 'Precision line selector for example.ts' })
    ).toHaveClass('flex', 'min-h-0', 'flex-col');
    expect(screen.getByTestId('tapestry-lens-lines')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
      'overscroll-contain'
    );
  });
});
