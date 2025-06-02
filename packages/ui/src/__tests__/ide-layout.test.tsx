import { fireEvent, render, screen } from '@testing-library/react';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import * as panelPersistence from '../hooks/use-panel-persistence';
import { IdeLayout } from '../layout/ide-layout';

// Capture layout handlers from mocked PanelGroup components
const handlers: { horizontal: Array<(sizes: number[]) => void> } = {
  horizontal: [],
};

// Mock react-resizable-panels with minimal implementation
vi.mock('react-resizable-panels', () => {
  const React = require('react') as typeof import('react');
  const { forwardRef, useImperativeHandle } = React;

  interface PanelGroupProps {
    direction?: string;
    onLayout?: (sizes: number[]) => void;
    children?: React.ReactNode;
  }

  const PanelGroup = ({ direction, onLayout, children }: PanelGroupProps) => {
    if (direction === 'horizontal' && typeof onLayout === 'function') {
      handlers.horizontal.push(onLayout);
    }
    return <div data-testid={`panel-group-${direction}`}>{children}</div>;
  };

  interface MockImperativeHandle {
    isCollapsed: () => boolean;
    isExpanded: () => boolean;
    expand: () => void;
    collapse: () => void;
  }

  interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
    children?: React.ReactNode;
  }

  const Panel = forwardRef<MockImperativeHandle, PanelProps>(({ children, ...props }, ref) => {
    useImperativeHandle(ref, () => ({
      isCollapsed: () => false,
      isExpanded: () => true,
      expand: vi.fn(),
      collapse: vi.fn(),
    }));
    return (
      <div data-testid="panel" {...props}>
        {children}
      </div>
    );
  });

  const PanelResizeHandle = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="resize-handle">{children}</div>
  );

  return { PanelGroup, Panel, PanelResizeHandle };
});

vi.mock('../hooks/use-panel-persistence', () => ({
  usePanelPersistence: vi.fn(),
}));

const navigationItems: never[] = [];

describe('IdeLayout', () => {
  const leftContent = <div>Left Content</div>;
  const rightContent = <div>Right Content</div>;
  const consoleContent = <div>Console Content</div>;

  const renderLayout = () =>
    render(
      <IdeLayout
        navigationItems={navigationItems}
        currentPath="/"
        leftPanelContent={leftContent}
        rightPanelContent={rightContent}
        consoleContent={consoleContent}
      >
        <div>Main</div>
      </IdeLayout>
    );

  let mockState: {
    saveLayout: Mock;
    toggleConsole: Mock;
    toggleLeftPanel: Mock;
    toggleRightPanel: Mock;
  } & Record<string, unknown>;

  beforeEach(() => {
    handlers.horizontal.length = 0;
    vi.clearAllMocks();

    mockState = {
      sizes: [25, 20, 30],
      showConsole: false,
      showLeftPanel: false,
      showRightPanel: false,
      saveLayout: vi.fn(),
      toggleConsole: vi.fn(),
      toggleLeftPanel: vi.fn(),
      toggleRightPanel: vi.fn(),
    } as unknown as typeof mockState;

    const usePanelPersistenceMock = panelPersistence.usePanelPersistence as unknown as Mock;
    usePanelPersistenceMock.mockReturnValue(mockState);
  });

  it('renders toggle buttons and calls toggle handlers', () => {
    renderLayout();

    const leftToggleButtons = screen.getAllByRole('button', {
      name: /Show explorer/i,
    });
    const leftToggle = leftToggleButtons[leftToggleButtons.length - 1];
    if (leftToggle) fireEvent.click(leftToggle);
    expect(mockState.toggleLeftPanel).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Show right panel/i }));
    expect(mockState.toggleRightPanel).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Show console/i }));
    expect(mockState.toggleConsole).toHaveBeenCalled();
  });

  it('calls saveLayout from layout callbacks', () => {
    // Set up state with visible panels to trigger layout handlers
    Object.assign(mockState, {
      showLeftPanel: true,
      showRightPanel: true,
      showConsole: true,
    });
    renderLayout();

    // handleHorizontalLayout from outer PanelGroup with left panel and console visible
    // Layout: [left, main+right, console] = [40, 50, 10]
    handlers.horizontal[0]?.([40, 50, 10]);
    expect(mockState.saveLayout).toHaveBeenCalledWith([40, 20, 10]);

    // handleVerticalLayout from inner PanelGroup with right panel visible
    // Layout: [main, right] = [60, 40]
    handlers.horizontal[1]?.([60, 40]);
    expect(mockState.saveLayout).toHaveBeenCalledWith([25, 40, 30]);
  });
});
