import { createTestActionRegistry } from '@brainstrike/context-actions';
import { TAPESTRY_COLOR_HEX } from '@brainstrike/types';
import { ActionRegistryProvider, TooltipProvider as BaseTooltipProvider } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const testActionRegistry = createTestActionRegistry().registry;
const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <ActionRegistryProvider registry={testActionRegistry}>
    <BaseTooltipProvider>{children}</BaseTooltipProvider>
  </ActionRegistryProvider>
);

const RangeRemovalHarness = () => {
  const [file, setFile] = useState(createFile);
  return (
    <Minimap
      file={file}
      getGlobalIndex={() => 1}
      isSelected={false}
      onRemoveRange={(_fileId, rangeId) =>
        setFile((current) => ({
          ...current,
          selections: current.selections.filter((range) => range.id !== rangeId),
        }))
      }
      onToggleRange={vi.fn()}
      onToggleSelection={vi.fn()}
      scale={2}
      smartStart={vi.fn()}
    />
  );
};

describe('Minimap', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  it('renders a bounded number of structure marks for very large files', () => {
    const file = {
      ...createFile(),
      content: Array.from({ length: 10_000 }, (_, index) => `line-${index}`),
      structure: Array.from({ length: 10_000 }, () => ({
        indent: 0,
        isEmpty: false,
        width: 40,
      })),
      totalLines: 10_000,
    };

    const { container } = render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={4}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(container.querySelectorAll('svg rect').length).toBeLessThanOrEqual(320);
  });

  it('keeps compact document controls at a 24px minimum pointer target', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByRole('checkbox', { name: /select \/src\/app\.tsx/i })).toHaveClass('size-6');
  });

  it('defers idle file loading until the code lens is invoked', () => {
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

    expect(onRequestFileContent).not.toHaveBeenCalled();

    fireEvent.pointerEnter(screen.getByTestId('tapestry-track'));

    expect(onRequestFileContent).toHaveBeenCalledWith('file-1');
  });

  it('requests idle file content only once while the pointer remains over the document', () => {
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

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerEnter(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 154, pointerType: 'mouse' });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 166, pointerType: 'mouse' });

    expect(onRequestFileContent).toHaveBeenCalledTimes(1);
    expect(onRequestFileContent).toHaveBeenCalledWith('file-1');
  });

  it('keeps an idle document keyboard-focusable and requests content on focus', () => {
    const onRequestFileContent = vi.fn();
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), content: [], contentStatus: 'idle' }}
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

    const background = screen.getByRole('button', { name: /loading file content for app\.tsx/i });
    expect(background).not.toBeDisabled();
    expect(background).toHaveAttribute('aria-disabled', 'true');

    fireEvent.focus(background);

    expect(onRequestFileContent).toHaveBeenCalledWith('file-1');
  });

  it.each([
    'touch',
    'pen',
  ] as const)('requests idle file content from a %s tap even when the tap does not focus the document', (pointerType) => {
    const onRequestFileContent = vi.fn();
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), content: [], contentStatus: 'idle' }}
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

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', { name: /loading file content for app\.tsx/i });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerDown(background, {
      button: 0,
      clientX: 40,
      clientY: 142,
      pointerId: 9,
      pointerType,
    });
    fireEvent.pointerUp(background, {
      button: 0,
      clientX: 40,
      clientY: 142,
      pointerId: 9,
      pointerType,
    });
    fireEvent.click(background, { clientX: 40, clientY: 142 });

    expect(onRequestFileContent).toHaveBeenCalledTimes(1);
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

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerEnter(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 154, pointerType: 'mouse' });

    expect(onRequestFileContent).not.toHaveBeenCalled();
  });

  it('keeps estimated line geometry read-only until file content is ready', () => {
    const file = {
      ...createFile(),
      content: [],
      contentStatus: 'loading' as const,
    };
    const onToggleRange = vi.fn();
    const onRequestFileContent = vi.fn();
    const smartStart = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onRequestFileContent={onRequestFileContent}
          onToggleRange={onToggleRange}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={smartStart}
        />
      </TooltipProvider>
    );

    const background = screen.getByRole('button', { name: /loading file content for app\.tsx/i });
    const range = screen.getByRole('slider', {
      name: /selection lines 3 to 6 in app\.tsx/i,
    });
    fireEvent.pointerDown(background, { clientY: 110, pointerId: 1 });
    fireEvent.pointerDown(range, { clientY: 110, pointerId: 1 });
    fireEvent.keyDown(range, { key: ' ' });
    fireEvent.contextMenu(range);
    fireEvent.focus(background);

    expect(background).not.toBeDisabled();
    expect(background).toHaveAttribute('aria-disabled', 'true');
    expect(range).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/loading file content/i)).toBeInTheDocument();
    expect(onRequestFileContent).not.toHaveBeenCalled();
    expect(smartStart).not.toHaveBeenCalled();
    expect(onToggleRange).not.toHaveBeenCalled();
  });

  it('shows a pointer-following code lens for any line under the document track', () => {
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

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    // Line 8 is outside the existing [2, 6) range. The lens follows the
    // document position rather than anchoring to a selected chunk.
    fireEvent.pointerMove(track, { clientX: 320, clientY: 202, pointerType: 'mouse' });

    const lens = screen.getByTestId('tapestry-lens');
    expect(lens).toHaveTextContent('App.tsx');
    expect(lens).toHaveTextContent('Line 9');
    expect(lens.querySelector('[data-lens-active="true"]')).toHaveTextContent('line-8');
    expect(lens).toHaveClass('pointer-events-none');

    fireEvent.pointerLeave(track);
    expect(screen.queryByTestId('tapestry-lens')).not.toBeInTheDocument();
  });

  it('recomputes the roving line when scrolling moves the track beneath a stationary pointer', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    let trackRect = createRect({ height: 120, top: 100 });
    vi.spyOn(track, 'getBoundingClientRect').mockImplementation(() => trackRect);
    fireEvent.pointerMove(track, { clientX: 320, clientY: 160, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 6');

    trackRect = createRect({ height: 120, top: 140 });
    fireEvent.scroll(window);

    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 2');
  });

  it('remeasures the roving line when a rerender changes track geometry beneath a stationary pointer', () => {
    const props = {
      file: createFile(),
      getGlobalIndex: () => 1,
      isSelected: false,
      onToggleRange: vi.fn(),
      onToggleSelection: vi.fn(),
      smartStart: vi.fn(),
    };
    const { rerender } = render(
      <TooltipProvider>
        <Minimap {...props} scale={2} />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    let trackRect = createRect({ height: 120, top: 100 });
    vi.spyOn(track, 'getBoundingClientRect').mockImplementation(() => trackRect);
    fireEvent.pointerMove(track, { clientX: 320, clientY: 160, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 6');

    trackRect = createRect({ height: 240, top: 140 });
    rerender(
      <TooltipProvider>
        <Minimap {...props} scale={3} />
      </TooltipProvider>
    );

    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 1');
    expect(
      screen.getByTestId('tapestry-lens').querySelector('[data-lens-active="true"]')
    ).toHaveTextContent('line-0');
  });

  it('keeps the roving lens synchronized after drag pointer capture leaves the track', () => {
    const props = {
      file: { ...createFile(), selections: [] },
      getGlobalIndex: () => 0,
      isSelected: false,
      onCreateRange: vi.fn(),
      onToggleRange: vi.fn(),
      onToggleSelection: vi.fn(),
      scale: 2,
      smartStart: vi.fn(),
    };
    const { rerender } = render(
      <TooltipProvider>
        <Minimap {...props} isDragging={false} />
      </TooltipProvider>
    );
    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerMove(track, { clientX: 80, clientY: 118, pointerType: 'mouse' });
    fireEvent.pointerDown(background, { button: 0, clientX: 80, clientY: 118, pointerId: 1 });
    fireEvent.pointerMove(background, { clientX: 80, clientY: 124, pointerId: 1 });
    expect(props.smartStart).toHaveBeenCalled();

    rerender(
      <TooltipProvider>
        <Minimap {...props} isDragging={true} />
      </TooltipProvider>
    );
    fireEvent.pointerMove(window, {
      clientX: 80,
      clientY: 202,
      pointerId: 1,
      pointerType: 'mouse',
    });

    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 9');
  });

  it('updates the roving lens across successive pointer positions', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerMove(track, { clientX: 320, clientY: 118, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 2');

    fireEvent.pointerMove(track, { clientX: 320, clientY: 202, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 9');
  });

  it('recomputes a stationary lens when estimated content geometry becomes ready', () => {
    const idleFile = {
      ...createFile(),
      content: [],
      contentStatus: 'idle' as const,
      totalLines: 100,
    };
    const readyFile = {
      ...createFile(),
      content: Array.from({ length: 10 }, (_, index) => `ready-${index}`),
      contentStatus: 'ready' as const,
      totalLines: 10,
    };
    const props = {
      getGlobalIndex: () => 1,
      isSelected: false,
      onToggleRange: vi.fn(),
      onToggleSelection: vi.fn(),
      scale: 2,
      smartStart: vi.fn(),
    };

    const { rerender } = render(
      <TooltipProvider>
        <Minimap file={idleFile} {...props} />
      </TooltipProvider>
    );
    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 190, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 76');

    rerender(
      <TooltipProvider>
        <Minimap file={readyFile} {...props} />
      </TooltipProvider>
    );

    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 8');
    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('ready-7');
  });

  it('dismisses the code lens with Escape until the pointer leaves the card', () => {
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

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerMove(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('tapestry-lens')).not.toBeInTheDocument();

    fireEvent.pointerMove(track, { clientX: 320, clientY: 154, pointerType: 'mouse' });
    expect(screen.queryByTestId('tapestry-lens')).not.toBeInTheDocument();

    fireEvent.pointerLeave(track);
    fireEvent.pointerMove(track, { clientX: 320, clientY: 154, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toBeInTheDocument();
  });

  it('dismisses the roving lens when Escape originates from the range toggle', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });

    const toggle = screen.getByRole('button', { name: /deactivate range/i });
    fireEvent.focus(toggle);
    fireEvent.keyDown(toggle, { key: 'Escape' });

    expect(screen.queryByTestId('tapestry-lens')).toBeNull();
  });

  it('dismisses the code lens when the window loses focus', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toBeInTheDocument();

    fireEvent.blur(window);

    expect(screen.queryByTestId('tapestry-lens')).toBeNull();

    fireEvent.pointerMove(track, { clientX: 320, clientY: 154, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toBeInTheDocument();
  });

  it('does not load or show code when the code lens is disabled', () => {
    const file = { ...createFile(), content: [], contentStatus: 'idle' as const };
    const onRequestFileContent = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          lensEnabled={false}
          onRequestFileContent={onRequestFileContent}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerEnter(track);
    fireEvent.pointerMove(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });

    expect(onRequestFileContent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tapestry-lens')).toBeNull();
  });

  it('keeps native precision selection available when only the roving lens is disabled', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          lensEnabled={false}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerMove(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });
    expect(screen.queryByTestId('tapestry-lens')).toBeNull();

    fireEvent.keyDown(background, { key: 'Enter' });

    expect(
      screen.getByRole('dialog', { name: /precision line selector for app\.tsx/i })
    ).toBeVisible();
  });

  it('allows offscreen document cards to defer rendering work', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByTestId('tapestry-document-card')).toHaveStyle({
      containIntrinsicSize: 'auto 174px',
      contentVisibility: 'auto',
      gridRowEnd: 'span 23',
    });
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

    expect(screen.getByText(/whole file.*click to inspect or drag to select/i)).toBeInTheDocument();
    // The create-range background button carries the accessible name for the
    // whole-file state (the visual "Whole file" hint is aria-hidden).
    expect(
      screen.getByRole('button', {
        name: /whole file selected — inspect or create range in app\.tsx/i,
      })
    ).toBeInTheDocument();
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

    expect(
      screen.queryByText(/whole file.*click to inspect or drag to select/i)
    ).not.toBeInTheDocument();
    // With ranges present the background button's accessible name is the plain
    // create-range label, never the whole-file variant.
    expect(
      screen.getByRole('button', { name: /^inspect or create range in app\.tsx$/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /whole file selected/i })).not.toBeInTheDocument();
  });

  it('uses smartStart for a coarse range only after the background drag threshold', () => {
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

    const container = screen.getByRole('button', { name: /inspect or create range in app\.tsx/i });
    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    const clientY = 110;
    fireEvent.pointerDown(container, { clientX: 10, clientY, pointerId: 1 });
    expect(smartStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(container, { clientX: 10, clientY: 116, pointerId: 1 });

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

  it('does not create a range from a secondary pointer press', () => {
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

    const container = screen.getByRole('button', { name: /inspect or create range in app\.tsx/i });
    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerDown(container, { button: 2, clientY: 110, pointerId: 1 });
    fireEvent.pointerMove(container, { button: 2, clientY: 120, pointerId: 1 });
    fireEvent.contextMenu(container, { button: 2, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(container, { button: 2, clientY: 120, pointerId: 1 });

    expect(smartStart).not.toHaveBeenCalled();
  });

  it('does not create or move a range from a macOS Control-click', () => {
    const file = createFile();
    const onToggleRange = vi.fn();
    const smartStart = vi.fn();

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

    const background = screen.getByRole('button', { name: /inspect or create range in app\.tsx/i });
    const range = screen.getByRole('slider', {
      name: /selection lines 3 to 6 in app\.tsx/i,
    });
    Object.defineProperty(background, 'getBoundingClientRect', {
      value: () => createRect(),
    });

    fireEvent.pointerDown(background, { button: 0, clientY: 110, ctrlKey: true, pointerId: 1 });
    fireEvent.pointerDown(range, { button: 0, clientY: 42, ctrlKey: true, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: /deactivate range/i }), {
      button: 0,
      ctrlKey: true,
    });
    fireEvent.pointerDown(screen.getByTestId('resize-range-top'), {
      button: 0,
      clientY: 42,
      ctrlKey: true,
      pointerId: 1,
    });
    fireEvent.pointerDown(screen.getByTestId('resize-range-bottom'), {
      button: 0,
      clientY: 42,
      ctrlKey: true,
      pointerId: 1,
    });

    expect(smartStart).not.toHaveBeenCalled();
    expect(onToggleRange).not.toHaveBeenCalled();
  });

  it('pins precision rows on click and creates an exact large-file clip without a coarse drag', () => {
    const file = {
      ...createFile(),
      content: Array.from({ length: 10_000 }, (_, index) => `line-${index}`),
      selections: [],
      structure: [],
      totalLines: 10_000,
    };
    const onCreateRange = vi.fn();
    const smartStart = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={onCreateRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={4}
          smartStart={smartStart}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 640 }),
    });

    fireEvent.pointerDown(background, {
      button: 0,
      clientX: 80,
      clientY: 420,
      pointerId: 1,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(background, {
      button: 0,
      clientX: 80,
      clientY: 420,
      pointerId: 1,
      pointerType: 'mouse',
    });

    const precisionLens = screen.getByRole('dialog', {
      name: /precision line selector for app\.tsx/i,
    });
    expect(precisionLens).toBeVisible();
    expect(precisionLens).toHaveClass('max-w-[calc(100vw-24px)]');
    expect(precisionLens).toHaveStyle({ width: '304px' });
    expect(smartStart).not.toHaveBeenCalled();

    fireEvent.pointerLeave(track);
    expect(precisionLens).toBeVisible();

    fireEvent.keyDown(precisionLens, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: /create clip from line 5002/i }));

    expect(onCreateRange).toHaveBeenCalledWith(file.id, 5001);
  });

  it('reclamps a pinned precision selector when the viewport becomes narrower', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
      writable: true,
    });

    try {
      render(
        <TooltipProvider>
          <Minimap
            file={{ ...createFile(), selections: [] }}
            getGlobalIndex={() => 0}
            isSelected={false}
            onCreateRange={vi.fn()}
            onToggleRange={vi.fn()}
            onToggleSelection={vi.fn()}
            scale={2}
            smartStart={vi.fn()}
          />
        </TooltipProvider>
      );

      const track = screen.getByTestId('tapestry-track');
      const background = screen.getByRole('button', {
        name: /whole file selected — inspect or create range in app\.tsx/i,
      });
      Object.defineProperty(track, 'getBoundingClientRect', {
        value: () => createRect({ height: 120 }),
      });
      fireEvent.pointerDown(background, {
        button: 0,
        clientX: 900,
        clientY: 160,
        pointerId: 7,
        pointerType: 'mouse',
      });
      fireEvent.pointerUp(background, {
        button: 0,
        clientX: 900,
        clientY: 160,
        pointerId: 7,
        pointerType: 'mouse',
      });

      const lens = screen.getByRole('dialog', {
        name: /precision line selector for app\.tsx/i,
      });
      expect(lens).toHaveStyle({ left: '576px' });

      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 500,
        writable: true,
      });
      fireEvent.resize(window);

      expect(lens).toHaveStyle({ left: '184px' });
    } finally {
      if (originalWidth) {
        Object.defineProperty(window, 'innerWidth', originalWidth);
      }
    }
  });

  it('keeps a pinned selector open when a touch range tap only preclaims context', () => {
    const onPinnedLensChange = vi.fn();
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onCreateRange={vi.fn()}
          onPinnedLensChange={onPinnedLensChange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', { name: /inspect or create range in app\.tsx/i });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerDown(background, {
      button: 0,
      clientX: 80,
      clientY: 202,
      pointerId: 7,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(background, {
      button: 0,
      clientX: 80,
      clientY: 202,
      pointerId: 7,
      pointerType: 'mouse',
    });
    expect(
      screen.getByRole('dialog', { name: /precision line selector for app\.tsx/i })
    ).toBeVisible();
    onPinnedLensChange.mockClear();

    const range = screen.getByRole('slider', {
      name: /selection lines 3 to 6 in app\.tsx/i,
    });
    fireEvent.pointerDown(range, { button: 0, pointerId: 8, pointerType: 'touch' });
    fireEvent.pointerUp(range, { button: 0, pointerId: 8, pointerType: 'touch' });

    expect(onPinnedLensChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: /precision line selector for app\.tsx/i })
    ).toBeVisible();
  });

  it('opens the precision selector from a touch tap', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerDown(background, {
      button: 0,
      clientX: 80,
      clientY: 160,
      pointerId: 7,
      pointerType: 'touch',
    });
    fireEvent.pointerUp(background, {
      button: 0,
      clientX: 80,
      clientY: 160,
      pointerId: 7,
      pointerType: 'touch',
    });

    expect(
      screen.getByRole('dialog', { name: /precision line selector for app\.tsx/i })
    ).toHaveTextContent('Line 6');
  });

  it('opens the precision selector from native programmatic button activation', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.click(background, { detail: 0 });

    expect(
      screen.getByRole('dialog', { name: /precision line selector for app\.tsx/i })
    ).toHaveTextContent('Line 1');
  });

  it('clamps a pinned line when refreshed content becomes shorter', () => {
    const props = {
      getGlobalIndex: () => 0,
      isSelected: false,
      onCreateRange: vi.fn(),
      onToggleRange: vi.fn(),
      onToggleSelection: vi.fn(),
      scale: 2,
      smartStart: vi.fn(),
    };
    const longFile = {
      ...createFile(),
      content: Array.from({ length: 100 }, (_, index) => `long-${index}`),
      selections: [],
      totalLines: 100,
    };
    const { rerender } = render(
      <TooltipProvider>
        <Minimap {...props} file={longFile} />
      </TooltipProvider>
    );
    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 100, top: 0 }),
    });
    fireEvent.pointerDown(background, { button: 0, clientX: 80, clientY: 89, pointerId: 1 });
    fireEvent.pointerUp(background, { button: 0, clientX: 80, clientY: 89, pointerId: 1 });
    expect(screen.getByRole('dialog')).toHaveTextContent('Line 90');

    rerender(
      <TooltipProvider>
        <Minimap
          {...props}
          file={{
            ...longFile,
            content: Array.from({ length: 10 }, (_, index) => `short-${index}`),
            totalLines: 10,
          }}
        />
      </TooltipProvider>
    );

    expect(screen.getByRole('dialog')).toHaveTextContent('Line 10');
    expect(screen.getByRole('status')).toHaveTextContent('short-9');
  });

  it('closes a pinned selector before disabling the lens and does not resurrect it', async () => {
    const onLensEnabledChange = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          lensEnabled={true}
          onCreateRange={vi.fn()}
          onLensEnabledChange={onLensEnabledChange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );
    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.keyDown(background, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeVisible();

    fireEvent.contextMenu(background, { clientX: 40, clientY: 142 });
    fireEvent.click(screen.getByRole('menuitem', { name: /disable code lens/i }));
    expect(onLensEnabledChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(background).toHaveFocus());

    rerender(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          lensEnabled={true}
          onCreateRange={vi.fn()}
          onLensEnabledChange={onLensEnabledChange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes a pinned precision lens with Escape and restores overview focus', () => {
    const onCreateRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={onCreateRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.focus(background);
    fireEvent.keyDown(background, { key: 'Enter' });

    fireEvent.keyDown(
      screen.getByRole('dialog', { name: /precision line selector for app\.tsx/i }),
      { key: 'Escape' }
    );

    expect(screen.queryByTestId('tapestry-lens')).toBeNull();
    expect(background).toHaveFocus();
  });

  it('releases pinned ownership when global Escape fires outside the selector', () => {
    const onPinnedLensChange = vi.fn();
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onPinnedLensChange={onPinnedLensChange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.keyDown(background, { key: 'Enter' });
    screen.getByRole('checkbox', { name: /select \/src\/app\.tsx/i }).focus();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: /precision line selector/i })).toBeNull();
    expect(onPinnedLensChange).toHaveBeenLastCalledWith(null);
    expect(background).toHaveFocus();
  });

  it('releases pinned ownership when blur or a context menu dismisses the selector', () => {
    const onPinnedLensChange = vi.fn();
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onPinnedLensChange={onPinnedLensChange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.keyDown(background, { key: 'Enter' });
    onPinnedLensChange.mockClear();
    fireEvent.blur(window);
    expect(onPinnedLensChange).toHaveBeenLastCalledWith(null);

    fireEvent.keyDown(background, { key: 'Enter' });
    onPinnedLensChange.mockClear();
    fireEvent.contextMenu(background, { clientX: 40, clientY: 142 });
    expect(onPinnedLensChange).toHaveBeenLastCalledWith(null);
  });

  it('restores overview focus when Escape originates from a pinned-lens control', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.keyDown(background, { key: 'Enter' });

    const closeButton = screen.getByRole('button', { name: /close precision line selector/i });
    fireEvent.focus(closeButton);
    fireEvent.keyDown(closeButton, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: /precision line selector/i })).toBeNull();
    expect(background).toHaveFocus();
  });

  it('does not run dialog create hotkeys from the close button', () => {
    const onCreateRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={onCreateRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.focus(background);
    fireEvent.keyDown(background, { key: 'Enter' });

    const closeButton = screen.getByRole('button', { name: /close precision line selector/i });
    fireEvent.keyDown(closeButton, { key: 'Enter' });

    expect(onCreateRange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /precision line selector/i })).toBeVisible();
  });

  it('includes the inspected code in each precision-row accessible name', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.keyDown(background, { key: 'Enter' });

    expect(screen.getByRole('button', { name: /create clip from line 1.*line-0/i })).toBeVisible();
  });

  it('bounds and normalizes the pinned-line live announcement', () => {
    const longLine = `   const    value = '${'x'.repeat(240)}';   `;
    render(
      <TooltipProvider>
        <Minimap
          file={{
            ...createFile(),
            content: [longLine, ...createFile().content.slice(1)],
            selections: [],
          }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.keyDown(
      screen.getByRole('button', {
        name: /whole file selected — inspect or create range in app\.tsx/i,
      }),
      { key: 'Enter' }
    );

    const announcement = screen.getByRole('status').textContent ?? '';
    expect(announcement).toContain("const value = '");
    expect(announcement.length).toBeLessThanOrEqual(110);
  });

  it('disables occupied precision rows instead of silently rejecting overlap', () => {
    const onCreateRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onCreateRange={onCreateRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', { name: /inspect or create range in app\.tsx/i });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.focus(background);
    fireEvent.keyDown(background, { key: 'Enter' });

    const precisionLens = screen.getByRole('dialog', {
      name: /precision line selector for app\.tsx/i,
    });
    expect(screen.getByRole('button', { name: /line 3 already selected/i })).toBeDisabled();
    expect(precisionLens).toHaveTextContent(/already in a clip/i);
    expect(screen.getByRole('status')).toHaveTextContent(/already selected/i);

    fireEvent.keyDown(precisionLens, { key: 'Enter' });
    expect(onCreateRange).not.toHaveBeenCalled();
  });

  it('creates a committed clip from the background context menu without entering drag state', () => {
    const onCreateRange = vi.fn();
    const smartStart = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={onCreateRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={smartStart}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.contextMenu(background, { clientX: 40, clientY: 166 });
    fireEvent.click(screen.getByRole('menuitem', { name: /create clip at line 6/i }));

    expect(onCreateRange).toHaveBeenCalledWith('file-1', 5);
    expect(smartStart).not.toHaveBeenCalled();
  });

  it('exposes document lens and whole-file actions from the background context menu', () => {
    const onClearManualRanges = vi.fn();
    const onLensEnabledChange = vi.fn();
    const onToggleSelection = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onClearManualRanges={onClearManualRanges}
          onLensEnabledChange={onLensEnabledChange}
          onToggleRange={vi.fn()}
          onToggleSelection={onToggleSelection}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', { name: /inspect or create range in app\.tsx/i });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.contextMenu(background, { clientX: 40, clientY: 202 });
    fireEvent.click(screen.getByRole('menuitem', { name: /disable code lens/i }));
    expect(onLensEnabledChange).toHaveBeenCalledWith(false);

    fireEvent.contextMenu(background, { clientX: 40, clientY: 202 });
    fireEvent.click(screen.getByRole('menuitem', { name: /use whole file/i }));
    expect(onClearManualRanges).toHaveBeenCalledWith('file-1');

    expect(onToggleSelection).not.toHaveBeenCalled();
  });

  it('cancels a pending touch tap when long-press opens the document menu', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [] }}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });

    fireEvent.pointerDown(background, {
      button: 0,
      clientX: 40,
      clientY: 142,
      pointerId: 9,
      pointerType: 'touch',
    });
    fireEvent.contextMenu(background, { clientX: 40, clientY: 142 });
    fireEvent.pointerUp(background, {
      button: 0,
      clientX: 40,
      clientY: 142,
      pointerId: 9,
      pointerType: 'touch',
    });

    expect(screen.getByRole('menuitem', { name: /create clip at line 4/i })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: /precision line selector/i })).toBeNull();
  });

  it('suppresses native activation when the Radix touch timer opens the document menu', () => {
    vi.useFakeTimers();
    try {
      render(
        <TooltipProvider>
          <Minimap
            file={{ ...createFile(), selections: [] }}
            getGlobalIndex={() => 0}
            isSelected={false}
            onCreateRange={vi.fn()}
            onToggleRange={vi.fn()}
            onToggleSelection={vi.fn()}
            scale={2}
            smartStart={vi.fn()}
          />
        </TooltipProvider>
      );

      const track = screen.getByTestId('tapestry-track');
      const background = screen.getByRole('button', {
        name: /whole file selected — inspect or create range in app\.tsx/i,
      });
      Object.defineProperty(track, 'getBoundingClientRect', {
        value: () => createRect({ height: 120 }),
      });

      fireEvent.pointerDown(background, {
        button: 0,
        clientX: 40,
        clientY: 142,
        pointerId: 9,
        pointerType: 'touch',
      });
      act(() => vi.advanceTimersByTime(700));

      expect(screen.getByRole('menuitem', { name: /create clip at line 4/i })).toBeVisible();

      fireEvent.pointerUp(background, {
        button: 0,
        clientX: 40,
        clientY: 142,
        pointerId: 9,
        pointerType: 'touch',
      });
      fireEvent.click(background, { clientX: 40, clientY: 142 });

      expect(screen.queryByRole('dialog', { name: /precision line selector/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not toggle a range behind its Radix touch long-press menu', () => {
    vi.useFakeTimers();
    try {
      const onToggleRange = vi.fn();
      render(
        <TooltipProvider>
          <Minimap
            file={createFile()}
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
      fireEvent.pointerDown(toggle, {
        button: 0,
        pointerId: 9,
        pointerType: 'touch',
      });
      act(() => vi.advanceTimersByTime(700));

      expect(screen.getByRole('menuitem', { name: /exclude clip/i })).toBeVisible();

      fireEvent.pointerUp(toggle, {
        button: 0,
        pointerId: 9,
        pointerType: 'touch',
      });
      fireEvent.click(toggle);

      expect(onToggleRange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still toggles a range after a short touch tap', () => {
    const onToggleRange = vi.fn();
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
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
    fireEvent.pointerDown(toggle, {
      button: 0,
      pointerId: 9,
      pointerType: 'touch',
    });
    fireEvent.pointerUp(toggle, {
      button: 0,
      pointerId: 9,
      pointerType: 'touch',
    });
    fireEvent.click(toggle);

    expect(onToggleRange).toHaveBeenCalledWith('file-1', 'range-1');
  });

  it('uses mixed-ownership wording and disables document creation on occupied lines', () => {
    const searchRange: TapestryRange = {
      ...createFile().selections[0]!,
      endLine: 9,
      id: 'search-range',
      origin: 'search',
      startLine: 7,
    };
    const onClearManualRanges = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={{ ...createFile(), selections: [...createFile().selections, searchRange] }}
          getGlobalIndex={() => 1}
          isSelected={false}
          onClearManualRanges={onClearManualRanges}
          onCreateRange={vi.fn()}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    const background = screen.getByRole('button', { name: /inspect or create range in app\.tsx/i });
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.contextMenu(background, { clientX: 40, clientY: 142 });

    expect(screen.getByRole('menuitem', { name: /create clip at line 4/i })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('menuitem', { name: /clear manual clips/i })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /use whole file/i })).toBeNull();
    expect(screen.getByText(/search clips stay managed by search/i)).toBeVisible();
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

    const range = screen.getByRole('slider', {
      name: /selection lines 3 to 6 in app\.tsx/i,
    });
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

  it('toggles range activity with pointer or keyboard activation', () => {
    const file = createFile();
    const onToggleRange = vi.fn();
    const smartStart = vi.fn();

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

    const toggle = screen.getByRole('button', { name: /deactivate range/i });
    fireEvent.pointerDown(toggle, { button: 0, clientY: 42, pointerId: 1 });
    fireEvent.pointerMove(toggle, { button: 0, clientY: 48, pointerId: 1 });
    fireEvent.pointerUp(toggle, { button: 0, clientY: 48, pointerId: 1 });
    fireEvent.click(toggle);
    fireEvent.keyDown(toggle, { key: 'Enter' });
    fireEvent.click(toggle, { detail: 0 });

    expect(onToggleRange).toHaveBeenCalledTimes(2);
    expect(onToggleRange).toHaveBeenNthCalledWith(1, file.id, 'range-1');
    expect(onToggleRange).toHaveBeenNthCalledWith(2, file.id, 'range-1');
    expect(smartStart).not.toHaveBeenCalled();
  });

  it('does not toggle or resize a range from a secondary pointer press', () => {
    const file = createFile();
    const onToggleRange = vi.fn();
    const smartStart = vi.fn();

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

    fireEvent.pointerDown(screen.getByRole('button', { name: /deactivate range/i }), {
      button: 2,
    });
    fireEvent.pointerDown(screen.getByTestId('resize-range-top'), {
      button: 2,
      clientY: 42,
      pointerId: 1,
    });
    fireEvent.pointerDown(screen.getByTestId('resize-range-bottom'), {
      button: 2,
      clientY: 42,
      pointerId: 1,
    });

    expect(onToggleRange).not.toHaveBeenCalled();
    expect(smartStart).not.toHaveBeenCalled();
  });

  it('creates an exact one-line clip from the keyboard detail inspector in a large file', () => {
    const file = {
      ...createFile(),
      content: Array.from({ length: 10_000 }, (_, index) => `line-${index}`),
      selections: [],
      structure: Array.from({ length: 10_000 }, () => ({
        indent: 0,
        isEmpty: false,
        width: 40,
      })),
      totalLines: 10_000,
    };
    const onCreateRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 0}
          isSelected={false}
          onCreateRange={onCreateRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={4}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const background = screen.getByRole('button', {
      name: /whole file selected — inspect or create range in app\.tsx/i,
    });
    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 640 }),
    });

    fireEvent.focus(background);
    fireEvent.keyDown(background, { key: 'Enter' });
    const precisionLens = screen.getByRole('dialog', {
      name: /precision line selector for app\.tsx/i,
    });
    fireEvent.keyDown(precisionLens, { key: 'PageDown' });
    fireEvent.keyDown(precisionLens, { key: 'ArrowDown' });

    expect(screen.getByTestId('tapestry-lens')).toHaveTextContent('Line 12');
    expect(screen.getByRole('status')).toHaveTextContent('Line 12, available: line-11');

    fireEvent.keyDown(precisionLens, { key: 'Enter' });

    expect(onCreateRange).toHaveBeenCalledWith(file.id, 11);
  });

  it('toggles inclusion from the range context menu', () => {
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

    fireEvent.contextMenu(
      screen.getByRole('slider', { name: /selection lines 3 to 6 in app\.tsx/i })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /exclude clip/i }));

    expect(onToggleRange).toHaveBeenCalledWith(file.id, 'range-1');
    expect(screen.queryByRole('menuitem', { name: /create clip at line/i })).toBeNull();
  });

  it('dismisses the pointer lens before opening a range context menu', () => {
    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const track = screen.getByTestId('tapestry-track');
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => createRect({ height: 120 }),
    });
    fireEvent.pointerMove(track, { clientX: 320, clientY: 142, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toBeInTheDocument();

    fireEvent.contextMenu(
      screen.getByRole('slider', { name: /selection lines 3 to 6 in app\.tsx/i })
    );

    expect(screen.queryByTestId('tapestry-lens')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /exclude clip/i })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: /exclude clip/i }));
    fireEvent.pointerMove(track, { clientX: 320, clientY: 154, pointerType: 'mouse' });
    expect(screen.getByTestId('tapestry-lens')).toBeVisible();
  });

  it('changes a user-owned range to a named palette color', () => {
    const file = createFile();
    const onChangeRangeColor = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onChangeRangeColor={onChangeRangeColor}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    fireEvent.contextMenu(
      screen.getByRole('slider', { name: /selection lines 3 to 6 in app\.tsx/i })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /color: green/i }));

    expect(onChangeRangeColor).toHaveBeenCalledWith(file.id, 'range-1', TAPESTRY_COLOR_HEX.green);
  });

  it('names removal of the final clip as switching back to whole-file context', () => {
    const file = createFile();
    const onRemoveRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onRemoveRange={onRemoveRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    fireEvent.contextMenu(
      screen.getByRole('slider', { name: /selection lines 3 to 6 in app\.tsx/i })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /use whole file/i }));

    expect(onRemoveRange).toHaveBeenCalledWith(file.id, 'range-1');
  });

  it('restores overview focus after a context action removes the focused range', async () => {
    render(
      <TooltipProvider>
        <RangeRemovalHarness />
      </TooltipProvider>
    );

    const range = screen.getByRole('slider', {
      name: /selection lines 3 to 6 in app\.tsx/i,
    });
    range.focus();
    fireEvent.contextMenu(range);
    fireEvent.click(screen.getByRole('menuitem', { name: /use whole file/i }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /whole file selected — inspect or create range in app\.tsx/i,
        })
      ).toHaveFocus();
    });
  });

  it('renders one-based inclusive selection bounds to users', () => {
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

    const range = screen.getByRole('slider', {
      name: /selection lines 3 to 6 in app\.tsx/i,
    });
    expect(range).toHaveAttribute('aria-valuemin', '1');
    expect(range).toHaveAttribute('aria-valuemax', '7');
    expect(range).toHaveAttribute('aria-valuenow', '3');
    expect(range).toHaveAttribute('aria-valuetext', 'Included, lines 3 to 6');
    expect(range).toHaveAttribute('aria-orientation', 'vertical');
    expect(range.querySelector('button')).toBeNull();
    expect(screen.getByTestId('move-range-grip')).toHaveClass('h-6', 'w-6');
    expect(screen.getByRole('button', { name: /deactivate range/i })).toHaveClass(
      'focus-visible:ring-2'
    );
    expect(screen.getByRole('button', { name: /inspect or create range/i })).toHaveClass(
      'focus-visible:ring-2'
    );
    expect(range).toHaveTextContent('3');
    expect(range).toHaveTextContent('6');
  });

  it('supports exact keyboard refinement of both clip boundaries', () => {
    const onMoveRange = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={createFile()}
          getGlobalIndex={() => 1}
          isSelected={false}
          onMoveRange={onMoveRange}
          onToggleRange={vi.fn()}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={vi.fn()}
        />
      </TooltipProvider>
    );

    const range = screen.getByRole('slider', {
      name: /selection lines 3 to 6 in app\.tsx/i,
    });

    fireEvent.keyDown(range, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(range, { altKey: true, key: 'ArrowUp' });

    expect(onMoveRange).toHaveBeenNthCalledWith(1, 'file-1', 'range-1', 1, 6);
    expect(onMoveRange).toHaveBeenNthCalledWith(2, 'file-1', 'range-1', 2, 5);
    expect(range).toHaveAttribute('aria-keyshortcuts', expect.stringContaining('Shift+ArrowUp'));
    expect(range).toHaveAttribute('aria-keyshortcuts', expect.stringContaining('Alt+ArrowDown'));
  });

  it('renders a search-owned range as managed and exposes no local mutators', () => {
    const file = {
      ...createFile(),
      selections: [{ ...createFile().selections[0]!, origin: 'search' as const }],
    };
    const onChangeRangeColor = vi.fn();
    const onMoveRange = vi.fn();
    const onRemoveRange = vi.fn();
    const onToggleRange = vi.fn();
    const smartStart = vi.fn();

    render(
      <TooltipProvider>
        <Minimap
          file={file}
          getGlobalIndex={() => 1}
          isSelected={false}
          onChangeRangeColor={onChangeRangeColor}
          onMoveRange={onMoveRange}
          onRemoveRange={onRemoveRange}
          onToggleRange={onToggleRange}
          onToggleSelection={vi.fn()}
          scale={2}
          smartStart={smartStart}
        />
      </TooltipProvider>
    );

    const range = screen.getByRole('note', {
      name: /selection lines 3 to 6 in app\.tsx.*managed by search/i,
    });
    expect(screen.getByText('Managed by Search')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /activate range|deactivate range/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resize range/i })).toBeNull();

    fireEvent.pointerDown(range, { button: 0, clientY: 42, pointerId: 1 });
    fireEvent.keyDown(range, { key: 'ArrowDown' });
    fireEvent.keyDown(range, { key: ' ' });
    fireEvent.contextMenu(range);

    expect(screen.getAllByText('Managed by Search').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('menuitemcheckbox', { name: /include selection/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /color|remove selection/i })).toBeNull();
    expect(smartStart).not.toHaveBeenCalled();
    expect(onMoveRange).not.toHaveBeenCalled();
    expect(onToggleRange).not.toHaveBeenCalled();
    expect(onChangeRangeColor).not.toHaveBeenCalled();
    expect(onRemoveRange).not.toHaveBeenCalled();
  });
});
