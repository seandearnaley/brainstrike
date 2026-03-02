import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { describe, expect, it, vi } from 'vitest';
import { ConsolePanel } from '../layout/console-panel';
import { ExplorerPanel } from '../layout/explorer-panel';
import { ToolsPanel } from '../layout/tools-panel';

interface MockPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  collapsedSize?: number | string;
  collapsible?: boolean;
  defaultSize?: number | string;
  maxSize?: number | string;
  minSize?: number | string;
  panelRef?: React.RefObject<PanelImperativeHandle | null>;
}

vi.mock('react-resizable-panels', () => ({
  Panel: ({
    children,
    panelRef,
    collapsedSize: _collapsedSize,
    collapsible: _collapsible,
    defaultSize: _defaultSize,
    maxSize: _maxSize,
    minSize: _minSize,
    ...props
  }: MockPanelProps) => {
    if (panelRef) {
      panelRef.current = {
        collapse: vi.fn(),
        expand: vi.fn(),
        getSize: vi.fn(() => ({ asPercentage: 50, inPixels: 500 })),
        isCollapsed: vi.fn(() => false),
        resize: vi.fn(),
      };
    }
    return (
      <div data-testid="mock-panel" {...props}>
        {children}
      </div>
    );
  },
  Separator: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="mock-separator" {...props}>
      {children}
    </div>
  ),
}));

describe('layout panel components', () => {
  it('renders ExplorerPanel and wires refs/attributes', () => {
    const onHide = vi.fn();
    const hideButtonRef = React.createRef<HTMLButtonElement>();
    const panelRef = React.createRef<PanelImperativeHandle>();

    render(
      <ExplorerPanel
        content={<div>Explorer content</div>}
        defaultSize={30}
        hideButtonRef={hideButtonRef}
        onHide={onHide}
        panelRef={panelRef}
      />
    );

    expect(screen.getByText('Explorer')).toBeInTheDocument();
    expect(screen.getByText('Explorer content')).toBeInTheDocument();
    expect(screen.getByTestId('mock-panel')).toHaveAttribute('data-panel-id', 'explorer-panel');
    expect(panelRef.current).toBeTruthy();
    expect(hideButtonRef.current).toBeTruthy();

    fireEvent.click(screen.getByTestId('hide-explorer-panel'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('renders ToolsPanel and triggers onHide', () => {
    const onHide = vi.fn();
    const panelRef = React.createRef<PanelImperativeHandle>();

    render(
      <ToolsPanel
        content={<div>Tools content</div>}
        defaultSize="25%"
        hideButtonRef={React.createRef<HTMLButtonElement>()}
        onHide={onHide}
        panelRef={panelRef}
      />
    );

    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('Tools content')).toBeInTheDocument();
    expect(screen.getByTestId('mock-panel')).toHaveAttribute('data-panel-id', 'tools-panel');
    expect(panelRef.current).toBeTruthy();

    fireEvent.click(screen.getByTestId('hide-tools-panel'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('renders ConsolePanel and triggers onHide', () => {
    const onHide = vi.fn();
    const panelRef = React.createRef<PanelImperativeHandle>();

    render(
      <ConsolePanel
        content={<div>Editor content</div>}
        defaultSize={40}
        hideButtonRef={React.createRef<HTMLButtonElement>()}
        onHide={onHide}
        panelRef={panelRef}
      />
    );

    expect(screen.getByText('File Editor')).toBeInTheDocument();
    expect(screen.getByText('Editor content')).toBeInTheDocument();
    expect(screen.getByTestId('mock-panel')).toHaveAttribute('data-panel-id', 'console-panel');
    expect(panelRef.current).toBeTruthy();

    fireEvent.click(screen.getByTestId('hide-console-panel'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
