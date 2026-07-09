import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Minimap } from '../minimap';
import type { FileTapestry, TapestryRange } from '../types';
import { getTapestryRenderMetrics } from '../utils';

const createFile = (): FileTapestry => {
  const range: TapestryRange = {
    color: '#ef4444',
    endLine: 6,
    id: 'range-1',
    isActive: true,
    startLine: 2,
  };

  return {
    compositeKey: 'file-1',
    content: Array.from({ length: 10 }, (_, index) => `line-${index}`),
    contentStatus: 'ready',
    id: 'file-1',
    language: 'tsx',
    name: 'App.tsx',
    path: '/src/App.tsx',
    rootFolderId: 'root',
    selections: [range],
    size: 1024,
    structure: Array.from({ length: 10 }, () => ({
      indent: 0,
      isEmpty: false,
      width: 40,
    })),
    tokens: 1200,
    totalLines: 10,
    type: 'TSX',
  };
};

const createRect = (overrides: Partial<DOMRect> = {}): DOMRect =>
  ({
    bottom: 120,
    height: 20,
    left: 0,
    right: 100,
    toJSON: () => '',
    top: 100,
    width: 100,
    x: 0,
    y: 100,
    ...overrides,
  }) as DOMRect;

describe('Minimap', () => {
  it('requests file content when an idle preview is rendered', () => {
    const file = {
      ...createFile(),
      content: [],
      contentStatus: 'idle' as const,
    };
    const onRequestFileContent = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onRequestFileContent={onRequestFileContent}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(onRequestFileContent).toHaveBeenCalledWith('file-1');
  });

  it('does not request file content again while a preview is already loading', () => {
    const file = {
      ...createFile(),
      content: [],
      contentStatus: 'loading' as const,
    };
    const onRequestFileContent = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onRequestFileContent={onRequestFileContent}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(onRequestFileContent).not.toHaveBeenCalled();
  });

  it('shows a whole-file affordance when a file has no ranges', () => {
    const file = { ...createFile(), selections: [] };

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByText(/whole file.*drag to select lines/i)).toBeInTheDocument();
    // The create-range background affordance stays available alongside it.
    expect(screen.getByRole('button', { name: /create range in app\.tsx/i })).toBeInTheDocument();
  });

  it('does not show the whole-file affordance when the file already has ranges', () => {
    const file = createFile();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.queryByText(/whole file.*drag to select lines/i)).not.toBeInTheDocument();
  });

  it('uses smartStart to create a range when clicking the background', () => {
    const file = createFile();
    const smartStart = vi.fn();
    const onToggleRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={onToggleRange}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={smartStart}
        />
      </TooltipProvider>
    );

    const container = screen.getByRole('button', { name: /create range in app\.tsx/i });
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => createRect(),
    });

    const clientY = 110;
    fireEvent.pointerDown(container, { clientY, pointerId: 1 });

    const { lineScale } = getTapestryRenderMetrics(file.totalLines, 2);
    const rawLine = Math.floor((clientY - 100) / lineScale);
    const expectedLine = Math.min(Math.max(rawLine, 0), file.totalLines - 1);

    expect(smartStart).toHaveBeenCalledWith(
      'CREATING',
      file.id,
      null,
      clientY,
      undefined,
      expectedLine,
      1
    );
  });

  it('calls smartStart with MOVING when dragging a range', () => {
    const file = createFile();
    const smartStart = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={smartStart}
        />
      </TooltipProvider>
    );

    const range = screen.getByRole('slider', { name: /range 2 to 6 in app\.tsx/i });
    fireEvent.pointerDown(range, { button: 0, clientY: 42, pointerId: 1 });

    expect(smartStart).toHaveBeenCalledWith(
      'MOVING',
      file.id,
      'range-1',
      42,
      expect.objectContaining({ id: 'range-1' }),
      undefined,
      1
    );
  });

  it('toggles range activity on mouse down', () => {
    const file = createFile();
    const onToggleRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={onToggleRange}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const toggle = screen.getByRole('button', { name: /deactivate range/i });
    fireEvent.pointerDown(toggle);

    expect(onToggleRange).toHaveBeenCalledWith(file.id, 'range-1');
  });
});
