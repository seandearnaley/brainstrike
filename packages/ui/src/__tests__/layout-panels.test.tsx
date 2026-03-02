import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConsolePanel } from '../layout/console-panel';
import { ExplorerPanel } from '../layout/explorer-panel';
import { ToolsPanel } from '../layout/tools-panel';

vi.mock('react-resizable-panels', () => ({
  Panel: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="mock-panel" {...props}>
      {children}
    </div>
  ),
  Separator: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="mock-separator" {...props}>
      {children}
    </div>
  ),
}));

describe('layout panel components', () => {
  it('renders ExplorerPanel and triggers onHide', () => {
    const onHide = vi.fn();
    render(
      <ExplorerPanel
        content={<div>Explorer content</div>}
        defaultSize={30}
        hideButtonRef={React.createRef<HTMLButtonElement>()}
        onHide={onHide}
        panelRef={React.createRef()}
      />
    );

    expect(screen.getByText('Explorer')).toBeInTheDocument();
    expect(screen.getByText('Explorer content')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('hide-explorer-panel'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('renders ToolsPanel and triggers onHide', () => {
    const onHide = vi.fn();
    render(
      <ToolsPanel
        content={<div>Tools content</div>}
        defaultSize="25%"
        hideButtonRef={React.createRef<HTMLButtonElement>()}
        onHide={onHide}
        panelRef={React.createRef()}
      />
    );

    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('Tools content')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('hide-tools-panel'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('renders ConsolePanel and triggers onHide', () => {
    const onHide = vi.fn();
    render(
      <ConsolePanel
        content={<div>Editor content</div>}
        defaultSize={40}
        hideButtonRef={React.createRef<HTMLButtonElement>()}
        onHide={onHide}
        panelRef={React.createRef()}
      />
    );

    expect(screen.getByText('File Editor')).toBeInTheDocument();
    expect(screen.getByText('Editor content')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('hide-console-panel'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
