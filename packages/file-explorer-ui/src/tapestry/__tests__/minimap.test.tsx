import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Minimap } from '../minimap';
import type { FileTapestry, TapestryRange } from '../types';

const createFile = (): FileTapestry => {
  const range: TapestryRange = {
    id: 'range-1',
    startLine: 2,
    endLine: 6,
    isActive: true,
    color: '#ef4444',
  };

  return {
    id: 'file-1',
    compositeKey: 'file-1',
    rootFolderId: 'root',
    path: '/src/App.tsx',
    name: 'App.tsx',
    language: 'tsx',
    type: 'TSX',
    size: 1024,
    tokens: 1200,
    totalLines: 10,
    structure: Array.from({ length: 10 }, () => ({
      indent: 0,
      width: 40,
      isEmpty: false,
    })),
    content: Array.from({ length: 10 }, (_, index) => `line-${index}`),
    selections: [range],
  };
};

const createRect = (overrides: Partial<DOMRect> = {}): DOMRect =>
  ({
    top: 100,
    left: 0,
    right: 100,
    bottom: 120,
    width: 100,
    height: 20,
    x: 0,
    y: 100,
    toJSON: () => '',
    ...overrides,
  }) as DOMRect;

describe('Minimap', () => {
  it('uses smartStart to create a range when clicking the background', () => {
    const file = createFile();
    const smartStart = vi.fn();
    const onInteractionStart = vi.fn();
    const onToggleRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onInteractionStart={onInteractionStart}
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

    fireEvent.mouseDown(container, { clientY: 110 });

    expect(smartStart).toHaveBeenCalledWith('CREATING', file.id, null, 110, undefined, 5);
    expect(onInteractionStart).not.toHaveBeenCalled();
  });

  it('starts moving ranges via onInteractionStart when smartStart is absent', () => {
    const file = createFile();
    const onInteractionStart = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onInteractionStart={onInteractionStart}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
        />
      </TooltipProvider>
    );

    const range = screen.getByRole('slider', { name: /range 2 to 6 in app\.tsx/i });
    fireEvent.mouseDown(range, { button: 0, clientY: 42 });

    expect(onInteractionStart).toHaveBeenCalledWith(
      'MOVING',
      file.id,
      'range-1',
      42,
      expect.objectContaining({ id: 'range-1' })
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
          onInteractionStart={vi.fn()}
          onToggleRange={onToggleRange}
          onToggleSelection={vi.fn()}
          scale={2}
        />
      </TooltipProvider>
    );

    const toggle = screen.getByRole('button', { name: /deactivate range/i });
    fireEvent.mouseDown(toggle);

    expect(onToggleRange).toHaveBeenCalledWith(file.id, 'range-1');
  });
});
