import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IdeLayout } from '../layout/ide-layout';
import { PanelLayoutProvider } from '../providers/panel-layout-provider';

// react-resizable-panels v4 mock - required because conditional panel rendering
// doesn't work well with the real library in JSDOM environment
vi.mock('react-resizable-panels', () => {
  const React = require('react') as typeof import('react');
  const { useImperativeHandle } = React;

  interface GroupProps {
    children?: React.ReactNode;
    onLayoutChanged?: (layout: { [id: string]: number }) => void;
    orientation?: string;
  }

  const Group = ({ children }: GroupProps) => <div data-testid="panel-group">{children}</div>;

  interface MockImperativeHandle {
    collapse: () => void;
    expand: () => void;
    isCollapsed: () => boolean;
  }

  interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
    children?: React.ReactNode;
    collapsedSize?: number;
    collapsible?: boolean;
    defaultSize?: number;
    maxSize?: number;
    minSize?: number;
    panelRef?: React.RefObject<MockImperativeHandle | null>;
  }

  const Panel = ({ children, panelRef, ...props }: PanelProps) => {
    const handle = {
      collapse: vi.fn(),
      expand: vi.fn(),
      isCollapsed: vi.fn().mockReturnValue(false),
    };
    useImperativeHandle(panelRef, () => handle);
    return (
      <div data-testid="panel" {...props}>
        {children}
      </div>
    );
  };

  const Separator = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="resize-handle">{children}</div>
  );

  return { Group, Panel, Separator };
});

function LayoutHarness() {
  return (
    <PanelLayoutProvider
      initialState={{
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
        sizes: [30, 50, 20],
      }}
    >
      <IdeLayout
        consoleContent={<div>Console</div>}
        leftPanelContent={<div>Left</div>}
        rightPanelContent={<div>Right</div>}
      >
        <div>Main</div>
      </IdeLayout>
    </PanelLayoutProvider>
  );
}

describe('PanelLayoutProvider integration', () => {
  it('uses provider state and toggles via IdeLayout controls', () => {
    render(<LayoutHarness />);

    // Left panel visible by default; hide it via button
    const hideLeft = screen.getByTestId('hide-explorer-panel');
    fireEvent.click(hideLeft);

    // Show-left shim should be visible after hiding
    expect(screen.getByTestId('show-explorer-panel')).toBeInTheDocument();

    // Show console via shim
    const showConsole = screen.getByTestId('show-console-panel');
    fireEvent.click(showConsole);

    // Console close button should appear
    expect(screen.getByTestId('hide-console-panel')).toBeInTheDocument();
  });
});
