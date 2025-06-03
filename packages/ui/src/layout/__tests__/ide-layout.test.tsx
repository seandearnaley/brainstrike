import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { IdeLayout, IdeLayoutProps } from '../ide-layout'; // Assuming IdeLayoutProps is exported
import { usePanelPersistence } from '../../hooks/use-panel-persistence'; // Adjust path as needed

// --- Mock usePanelPersistence ---
const mockUsePanelPersistenceDefaultState = {
  sizes: [25, 55, 20], // left, main, right (for vertical group) / left, main+right, console (for horizontal group)
  showConsole: false,
  showLeftPanel: true,
  showRightPanel: true,
  saveLayout: vi.fn(),
  toggleConsole: vi.fn(),
  toggleLeftPanel: vi.fn(),
  toggleRightPanel: vi.fn(),
  handleConsoleClose: vi.fn(), // Added as it's called by toggleConsole internally
};
let currentMockUsePanelPersistenceState = { ...mockUsePanelPersistenceDefaultState };
vi.mock('../../hooks/use-panel-persistence', () => ({
  usePanelPersistence: vi.fn(() => currentMockUsePanelPersistenceState),
}));

// --- Mock react-resizable-panels ---
const mockPanelGroup = vi.fn(({ children, onLayout, direction, id }) => (
  <div
    data-testid={`panel-group-${id || direction}`}
    data-direction={direction}
    data-onlayout-is-present={!!onLayout}
    // Allow tests to trigger onLayout
    // @ts-ignore
    data-trigger-layout={(...args) => onLayout(...args)}
  >
    {children}
  </div>
));
const mockPanel = vi.fn(({ children, id, defaultSize, collapsible, order, minSize, maxSize, collapsedSize }) => (
  <div
    data-testid={`panel-${id}`}
    data-defaultsize={defaultSize}
    data-collapsible={collapsible}
    data-order={order}
    data-minsize={minSize}
    data-maxsize={maxSize}
    data-collapsedsize={collapsedSize}
  >
    {children}
  </div>
));
const mockPanelResizeHandle = vi.fn(() => <div data-testid="panel-resize-handle" />);

vi.mock('react-resizable-panels', async () => {
  const actual = await vi.importActual('react-resizable-panels');
  return {
    ...actual,
    PanelGroup: mockPanelGroup,
    Panel: mockPanel,
    PanelResizeHandle: mockPanelResizeHandle,
  };
});

// --- Mock NavigationSidebar ---
vi.mock('../../navigation-sidebar', () => ({ // Adjust path as needed
  NavigationSidebar: vi.fn(({ children, items, currentPath, LinkComponent }) => (
    <nav
      data-testid="nav-sidebar"
      data-items={JSON.stringify(items)}
      data-path={currentPath}
      data-linkcomponent-present={!!LinkComponent}
    >
      {children}
    </nav>
  )),
}));

// --- Mock lucide-react icons ---
vi.mock('lucide-react', () => ({
  PanelLeft: () => <div data-testid="icon-panel-left">PanelLeft</div>,
  PanelRight: () => <div data-testid="icon-panel-right">PanelRight</div>,
  ChevronLeft: () => <div data-testid="icon-chevron-left">ChevronLeft</div>,
  ChevronRight: () => <div data-testid="icon-chevron-right">ChevronRight</div>,
  Terminal: () => <div data-testid="icon-terminal">Terminal</div>,
  X: () => <div data-testid="icon-x">X</div>,
  Settings2: () => <div data-testid="icon-settings2">Settings2</div>,
  // Add any other icons used directly by IdeLayout or its direct small sub-components if not mocked away
}));

// --- Mock utils ---
vi.mock('../../lib/utils', async () => {
  const actual = await vi.importActual('../../lib/utils');
  return {
    ...actual,
    cn: (...args) => args.filter(Boolean).join(' '), // Simple cn mock
    isDevEnv: vi.fn(() => false), // Mock isDevEnv
  };
});


const defaultChildren = <div data-testid="main-children">Main Content</div>;
const defaultNavigationItems = [{ id: 'nav1', label: 'Nav 1', href: '/nav1' }];
const defaultLeftPanelContent = <div data-testid="left-panel-content">Left Panel</div>;
const defaultRightPanelContent = <div data-testid="right-panel-content">Right Panel</div>;
const defaultConsoleContent = <div data-testid="console-content">Console Content</div>;

const getBaseProps = (overrides: Partial<IdeLayoutProps> = {}): IdeLayoutProps => ({
  children: defaultChildren,
  navigationItems: defaultNavigationItems,
  ...overrides,
});

describe('IdeLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock state for usePanelPersistence before each test
    currentMockUsePanelPersistenceState = {
      ...mockUsePanelPersistenceDefaultState,
      sizes: [...mockUsePanelPersistenceDefaultState.sizes], // Ensure sizes is a new array
      saveLayout: vi.fn(),
      toggleConsole: vi.fn(() => { // Make toggle also update the mock state for more realistic tests
        currentMockUsePanelPersistenceState.showConsole = !currentMockUsePanelPersistenceState.showConsole;
      }),
      toggleLeftPanel: vi.fn(() => {
        currentMockUsePanelPersistenceState.showLeftPanel = !currentMockUsePanelPersistenceState.showLeftPanel;
      }),
      toggleRightPanel: vi.fn(() => {
        currentMockUsePanelPersistenceState.showRightPanel = !currentMockUsePanelPersistenceState.showRightPanel;
      }),
      handleConsoleClose: vi.fn(() => { // Ensure this is also defined
         currentMockUsePanelPersistenceState.showConsole = false;
      }),
    };
    // Re-apply the mock implementation to pick up the reset state
     vi.mocked(usePanelPersistence).mockReturnValue(currentMockUsePanelPersistenceState);
  });

  describe('Initial Rendering & Panel Visibility', () => {
    it('renders with only children and navigationItems', () => {
      render(<IdeLayout {...getBaseProps()} />);
      expect(screen.getByTestId('nav-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('main-children')).toBeInTheDocument();

      expect(screen.queryByTestId('panel-left-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('panel-right-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('panel-console-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('panel-resize-handle')).not.toBeInTheDocument();

      // No floating toggle buttons
      expect(screen.queryByLabelText(/show explorer/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/show right panel/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/show console/i)).not.toBeInTheDocument();
    });

    it('renders left panel when leftPanelContent is provided and showLeftPanel is true', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = true;
      render(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent, leftPanelHeaderText: "Explorer" })} />);
      
      expect(screen.getByTestId('panel-left-panel')).toBeInTheDocument();
      expect(screen.getByText('Explorer')).toBeInTheDocument(); // Header text
      expect(screen.getByTestId('left-panel-content')).toBeInTheDocument();
      expect(screen.getByLabelText(/hide explorer/i)).toBeInTheDocument(); // Toggle button in header
      expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'left-panel', defaultSize: currentMockUsePanelPersistenceState.sizes[0] }), {});
    });

    it('hides left panel but shows floating toggle when showLeftPanel is false', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = false;
      render(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />);
      
      // Panel itself might be rendered but collapsed (defaultSize 0 or specific collapsedSize)
      // The key is that its content is not visible, and the floating button IS.
      expect(screen.queryByTestId('left-panel-content')).not.toBeInTheDocument(); // Content should be gone
      expect(screen.getByLabelText(/show explorer/i)).toBeInTheDocument(); // Floating button
      // Check if Panel was called with collapsedSize or defaultSize 0 if showLeftPanel is false
      expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'left-panel', collapsedSize: 0 }), {});
    });

    it('renders right panel when rightPanelContent is provided and showRightPanel is true', () => {
        currentMockUsePanelPersistenceState.showRightPanel = true;
        render(<IdeLayout {...getBaseProps({ rightPanelContent: defaultRightPanelContent, rightPanelHeaderText: "Details" })} />);
        
        expect(screen.getByTestId('panel-right-panel')).toBeInTheDocument();
        expect(screen.getByText('Details')).toBeInTheDocument();
        expect(screen.getByTestId('right-panel-content')).toBeInTheDocument();
        expect(screen.getByLabelText(/hide panel/i)).toBeInTheDocument();
        expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'right-panel', defaultSize: currentMockUsePanelPersistenceState.sizes[1] }), {});
    });

    it('hides right panel but shows floating toggle when showRightPanel is false', () => {
        currentMockUsePanelPersistenceState.showRightPanel = false;
        render(<IdeLayout {...getBaseProps({ rightPanelContent: defaultRightPanelContent })} />);
        
        expect(screen.queryByTestId('right-panel-content')).not.toBeInTheDocument();
        expect(screen.getByLabelText(/show right panel/i)).toBeInTheDocument();
        expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'right-panel', collapsedSize: 0 }), {});
    });

    it('hides console panel but shows floating toggle by default (showConsole: false)', () => {
        currentMockUsePanelPersistenceState.showConsole = false;
        render(<IdeLayout {...getBaseProps({ consoleContent: defaultConsoleContent })} />);
        
        expect(screen.queryByTestId('console-content')).not.toBeInTheDocument();
        expect(screen.getByLabelText(/show console/i)).toBeInTheDocument();
        expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'console-panel', collapsedSize: 0 }), {});
    });
    
    it('renders console panel when consoleContent is provided and showConsole is true', () => {
        currentMockUsePanelPersistenceState.showConsole = true;
        render(<IdeLayout {...getBaseProps({ consoleContent: defaultConsoleContent, consoleHeaderText: "Output" })} />);
        
        expect(screen.getByTestId('panel-console-panel')).toBeInTheDocument();
        expect(screen.getByText('Output')).toBeInTheDocument();
        expect(screen.getByTestId('console-content')).toBeInTheDocument();
        expect(screen.getByLabelText(/close console/i)).toBeInTheDocument(); // X button in header
        expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'console-panel', defaultSize: currentMockUsePanelPersistenceState.sizes[2] }), {});
    });

    it('renders navigationChildren within NavigationSidebar', () => {
      const navChildren = <div data-testid="nav-children-test">Nav Children</div>;
      render(<IdeLayout {...getBaseProps({ navigationChildren: navChildren })} />);
      expect(screen.getByTestId('nav-sidebar')).toContainElement(screen.getByTestId('nav-children-test'));
    });
  });

  describe('Panel Toggle Interactions', () => {
    const user = userEvent.setup();

    // Left Panel
    it('calls toggleLeftPanel when "Hide explorer" button is clicked (left panel visible)', async () => {
      currentMockUsePanelPersistenceState.showLeftPanel = true;
      render(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent, leftPanelHeaderText: "Explorer" })} />);
      const hideButton = screen.getByLabelText(/hide explorer/i);
      await user.click(hideButton);
      expect(currentMockUsePanelPersistenceState.toggleLeftPanel).toHaveBeenCalledTimes(1);
    });

    it('calls toggleLeftPanel when floating "Show explorer" button is clicked (left panel hidden)', async () => {
      currentMockUsePanelPersistenceState.showLeftPanel = false;
      render(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />);
      const showButton = screen.getByLabelText(/show explorer/i);
      await user.click(showButton);
      expect(currentMockUsePanelPersistenceState.toggleLeftPanel).toHaveBeenCalledTimes(1);
    });

    // Right Panel
    it('calls toggleRightPanel when "Hide panel" button is clicked (right panel visible)', async () => {
      currentMockUsePanelPersistenceState.showRightPanel = true;
      render(<IdeLayout {...getBaseProps({ rightPanelContent: defaultRightPanelContent, rightPanelHeaderText: "Details" })} />);
      const hideButton = screen.getByLabelText(/hide panel/i);
      await user.click(hideButton);
      expect(currentMockUsePanelPersistenceState.toggleRightPanel).toHaveBeenCalledTimes(1);
    });

    it('calls toggleRightPanel when floating "Show right panel" button is clicked (right panel hidden)', async () => {
      currentMockUsePanelPersistenceState.showRightPanel = false;
      render(<IdeLayout {...getBaseProps({ rightPanelContent: defaultRightPanelContent })} />);
      const showButton = screen.getByLabelText(/show right panel/i);
      await user.click(showButton);
      expect(currentMockUsePanelPersistenceState.toggleRightPanel).toHaveBeenCalledTimes(1);
    });

    // Console Panel
    it('calls toggleConsole (via handleConsoleClose) when "Close console" button (X) is clicked (console visible)', async () => {
      currentMockUsePanelPersistenceState.showConsole = true;
      render(<IdeLayout {...getBaseProps({ consoleContent: defaultConsoleContent, consoleHeaderText: "Output" })} />);
      // The X button is for handleConsoleClose, which then calls toggleConsole(false)
      const closeButton = screen.getByLabelText(/close console/i); 
      await user.click(closeButton);
      // toggleConsole itself might be called with 'false' or handleConsoleClose is called.
      // Based on current mock, toggleConsole is called, which updates the state.
      // Let's assume toggleConsole is the primary interaction point from the component's perspective.
      // If handleConsoleClose is the direct handler, then check that.
      // The component calls `hook.toggleConsole(false)` via `handleConsoleClose`.
      // Our mocked toggleConsole will flip the boolean state.
      // To test it was explicitly closed, we'd need to check `handleConsoleClose` or `toggleConsole(false)`
      // Let's adjust the mock for toggleConsole to see if it was called to set to false.
      const specificToggleConsoleMock = vi.fn();
      currentMockUsePanelPersistenceState.toggleConsole = specificToggleConsoleMock;
       vi.mocked(usePanelPersistence).mockReturnValue(currentMockUsePanelPersistenceState); // re-mock
      
      render(<IdeLayout {...getBaseProps({ consoleContent: defaultConsoleContent, consoleHeaderText: "Output" })} />);
      const newCloseButton = screen.getByLabelText(/close console/i); 
      await user.click(newCloseButton);

      expect(specificToggleConsoleMock).toHaveBeenCalledWith(false);
    });
    
    it('calls toggleConsole when floating "Show console" button is clicked (console hidden)', async () => {
      currentMockUsePanelPersistenceState.showConsole = false;
       vi.mocked(usePanelPersistence).mockReturnValue(currentMockUsePanelPersistenceState); // re-mock
      render(<IdeLayout {...getBaseProps({ consoleContent: defaultConsoleContent })} />);
      const showButton = screen.getByLabelText(/show console/i);
      await user.click(showButton);
      // This toggle should make it true
      expect(currentMockUsePanelPersistenceState.toggleConsole).toHaveBeenCalledWith(true);
    });
  });

  describe('Panel Resizing (onLayout callbacks)', () => {
    const triggerLayout = (panelGroupId: string, layout: number[]) => {
      const panelGroup = screen.getByTestId(panelGroupId);
      // @ts-ignore - data-trigger-layout is a custom attribute for testing
      panelGroup.dataset.triggerLayout(layout);
    };

    it('handleHorizontalLayout: left panel visible, console hidden - calls saveLayout correctly', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = true;
      currentMockUsePanelPersistenceState.showConsole = false;
      currentMockUsePanelPersistenceState.sizes = [20, 60, 20]; // left, main, right(persisted but not in this group's layout directly)
      // Console size is also persisted separately in the hook's full sizes array.
      // Let's assume the full persisted array in hook is [left, right, console] -> [20, 20, 15]
      // and current layout is [left, mainWithRight]
      // The horizontal group for IdeLayout is (left, mainAndRight, console)
      // If console is hidden, its layout is [left, mainAndRight]
      // If console is visible, its layout is [left, mainAndRight, console]

      // Horizontal group contains: Left Panel, (Main Content + Right Panel), Console Panel
      // If console is hidden, PanelGroup layout is [leftSize, mainPlusRightSize]
      // If console is visible, PanelGroup layout is [leftSize, mainPlusRightSize, consoleSize]
      
      render(
        <IdeLayout
          {...getBaseProps({
            leftPanelContent: defaultLeftPanelContent,
            rightPanelContent: defaultRightPanelContent, // Right panel exists, part of mainAndRight
            consoleContent: defaultConsoleContent, // Console exists but is hidden
          })}
        />
      );
      
      const newLeftSize = 30;
      const newMainPlusRightSize = 70; // This is the combined size of main and right panel area
      
      // The main horizontal PanelGroup is identified by direction="horizontal" by default in the component
      // Or by the ID 'ide-layout-horizontal-group'
      triggerLayout('panel-group-ide-layout-horizontal-group', [newLeftSize, newMainPlusRightSize]);
      
      // saveLayout expects [left, right, console]
      // current right size is from hook.sizes[1] (20)
      // current console size is from hook.sizes[2] (e.g. 20 if default)
      const expectedRightSize = currentMockUsePanelPersistenceState.sizes[1];
      const expectedConsoleSize = currentMockUsePanelPersistenceState.sizes[2]; // Persisted console size
      expect(currentMockUsePanelPersistenceState.saveLayout).toHaveBeenCalledWith([newLeftSize, expectedRightSize, expectedConsoleSize]);
    });

    it('handleHorizontalLayout: left panel visible, console visible - calls saveLayout correctly', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = true;
      currentMockUsePanelPersistenceState.showConsole = true;
      currentMockUsePanelPersistenceState.sizes = [25, 50, 25]; // left, right, console
      
      render(
        <IdeLayout
          {...getBaseProps({
            leftPanelContent: defaultLeftPanelContent,
            rightPanelContent: defaultRightPanelContent,
            consoleContent: defaultConsoleContent,
          })}
        />
      );
      
      const newLeftSize = 20;
      const newMainPlusRightSize = 50; // This is main + right panel area
      const newConsoleSize = 30;
      triggerLayout('panel-group-ide-layout-horizontal-group', [newLeftSize, newMainPlusRightSize, newConsoleSize]);
      
      const expectedRightSize = currentMockUsePanelPersistenceState.sizes[1]; // Original right panel size
      expect(currentMockUsePanelPersistenceState.saveLayout).toHaveBeenCalledWith([newLeftSize, expectedRightSize, newConsoleSize]);
    });
    
    it('handleHorizontalLayout: left panel hidden, console visible - calls saveLayout correctly', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = false;
      currentMockUsePanelPersistenceState.showConsole = true;
      currentMockUsePanelPersistenceState.sizes = [0, 60, 25]; // left (collapsed), right, console
      
      render(
        <IdeLayout
          {...getBaseProps({
            leftPanelContent: defaultLeftPanelContent,
            rightPanelContent: defaultRightPanelContent,
            consoleContent: defaultConsoleContent,
          })}
        />
      );
      
      // When left is hidden, the horizontal group layout is [mainPlusRightSize, consoleSize]
      const newMainPlusRightSize = 70;
      const newConsoleSize = 30;
      triggerLayout('panel-group-ide-layout-horizontal-group', [newMainPlusRightSize, newConsoleSize]);
      
      const expectedLeftSize = currentMockUsePanelPersistenceState.sizes[0]; // Should be 0 or collapsed size
      const expectedRightSize = currentMockUsePanelPersistenceState.sizes[1];
      expect(currentMockUsePanelPersistenceState.saveLayout).toHaveBeenCalledWith([expectedLeftSize, expectedRightSize, newConsoleSize]);
    });

    it('handleVerticalLayout: right panel visible - calls saveLayout correctly', () => {
      currentMockUsePanelPersistenceState.showRightPanel = true;
      // hook.sizes = [left, right, console]
      currentMockUsePanelPersistenceState.sizes = [25, 20, 15]; 
      
      render(
        <IdeLayout
          {...getBaseProps({
            leftPanelContent: defaultLeftPanelContent, // needed for full layout structure
            rightPanelContent: defaultRightPanelContent,
            // consoleContent not strictly needed for this vertical group test if console is hidden
          })}
        />
      );

      // The vertical group is for Main Content Area & Right Panel. Layout: [mainContentSize, rightPanelSize]
      const newMainContentSize = 60;
      const newRightPanelSize = 40;
      triggerLayout('panel-group-ide-main-vertical-group', [newMainContentSize, newRightPanelSize]);
      
      const expectedLeftSize = currentMockUsePanelPersistenceState.sizes[0];
      const expectedConsoleSize = currentMockUsePanelPersistenceState.sizes[2];
      expect(currentMockUsePanelPersistenceState.saveLayout).toHaveBeenCalledWith([expectedLeftSize, newRightPanelSize, expectedConsoleSize]);
    });
    
    it('handleVerticalLayout: right panel hidden - saveLayout uses persisted right panel size', () => {
      currentMockUsePanelPersistenceState.showRightPanel = false;
      currentMockUsePanelPersistenceState.sizes = [30, 0, 20]; // left, right (collapsed), console
      
      render(
        <IdeLayout
          {...getBaseProps({
            leftPanelContent: defaultLeftPanelContent,
            rightPanelContent: defaultRightPanelContent, // Content provided, but panel is hidden
          })}
        />
      );

      // If right panel is hidden, the vertical group's onLayout might not be triggered for it,
      // or it might be called with a single [100] for the main content.
      // This test primarily ensures that if it *were* called (e.g. due to console resize affecting overall height),
      // the persisted right panel size (0 or collapsed) is maintained.

      // Let's simulate a scenario where the vertical group is just the main content area.
      // The `handleVerticalLayout` is only attached if rightPanelContent is provided.
      // If showRightPanel is false, the Panel for rightPanel gets collapsedSize={0}.
      // The onLayout of the vertical group would then be `[mainSize, 0]` if it was forced to report.
      // However, typically a user wouldn't resize a collapsed panel's group like that.

      // More practically, if a resize happens on the HORIZONTAL group, and we need to calculate
      // the right panel size for `saveLayout`, it should use the persisted collapsed size.
      // This is implicitly covered by the horizontal tests.

      // For this specific vertical test, if right panel is hidden, handleVerticalLayout might not be directly useful.
      // Let's ensure no error and saveLayout is not called if the layout doesn't change meaningfully for it.
      // react-resizable-panels might not even call onLayout if only one panel is effectively visible in the group.
      // So, let's test that saveLayout is NOT called if we try to trigger layout for the vertical group
      // when the right panel is hidden, as there's nothing to resize there.
      const panelGroup = screen.queryByTestId('panel-group-ide-main-vertical-group');
      if (panelGroup && panelGroup.dataset.onlayoutIsPresent === 'true') {
        // @ts-ignore
        panelGroup.dataset.triggerLayout([100]); // Main content takes all space
      }
      // We expect saveLayout NOT to be called by handleVerticalLayout because there's no second panel to get a size from.
      // Any saveLayout calls would come from other group adjustments.
      // This needs careful consideration of how react-resizable-panels behaves with one non-collapsed panel.
      // The current implementation of `handleVerticalLayout` in IdeLayout.tsx:
      // `const newRightPanelSize = showRightPanel ? layout[1] : safeRightSize;`
      // `saveLayout([safeLeftSize, newRightPanelSize, safeConsoleSize]);`
      // This means it WILL call saveLayout.
      
      triggerLayout('panel-group-ide-main-vertical-group', [100]); // Main content gets 100%
      
      const expectedLeftSize = currentMockUsePanelPersistenceState.sizes[0];
      const expectedRightSize = currentMockUsePanelPersistenceState.sizes[1]; // This should be 0 (collapsed)
      const expectedConsoleSize = currentMockUsePanelPersistenceState.sizes[2];
      expect(currentMockUsePanelPersistenceState.saveLayout).toHaveBeenCalledWith([expectedLeftSize, expectedRightSize, expectedConsoleSize]);
    });
  });

  describe('Left Panel Imperative Collapse/Expand (useEffect)', () => {
    let mockLeftPanelRef;

    beforeEach(() => {
      mockLeftPanelRef = {
        isCollapsed: vi.fn(),
        isExpanded: vi.fn(),
        expand: vi.fn(),
        collapse: vi.fn(),
      };
      // Mock the ref assignment. This is a bit tricky.
      // We can try to intercept the ref prop of the Panel component.
      // Or, more simply, since leftPanelRef is internal to IdeLayout,
      // we can't directly assign to it from the test.
      // The useEffect uses `leftPanelRef.current`.
      // react-resizable-panels' Panel component takes a `ref` prop.
      // We need to ensure our mockLeftPanelRef is what `leftPanelRef.current` becomes.

      // For this test, we will rely on the Panel mock to capture the ref
      // and then we can simulate its methods. This is indirect.
      // A more direct approach might involve exporting the ref or using a test-specific prop.
      // Given the current structure, we'll assume the ref is correctly passed to the Panel.
      // The effect itself is what we're testing.
      
      // Let's refine the Panel mock to capture the ref and allow us to set our mockPanelRef
      vi.mocked(mockPanel).mockImplementation(({ children, id, ...props }) => {
        if (id === 'left-panel' && props.ref) {
          // @ts-ignore
          props.ref.current = mockLeftPanelRef; 
        }
        return (
          <div data-testid={`panel-${id}`} {...props}>
            {children}
          </div>
        );
      });
       vi.useFakeTimers(); // For requestAnimationFrame if used by panels
    });
    
    afterEach(() => {
        vi.runOnlyPendingTimers(); // Clear any timers
        vi.useRealTimers();
    });

    it('calls leftPanelRef.expand() when showLeftPanel becomes true and panel was collapsed', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = false; // Initial state: hidden
      mockLeftPanelRef.isCollapsed.mockReturnValue(true);
      mockLeftPanelRef.isExpanded.mockReturnValue(false);

      const { rerender } = render(
        <IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />
      );
      
      // Ensure panel ref is set up by initial render
      // This check is a bit weak due to the ref mocking strategy, but let's assume it works.
      expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({id: 'left-panel'}), {});


      act(() => {
        currentMockUsePanelPersistenceState.showLeftPanel = true; // Toggle to show
         vi.mocked(usePanelPersistence).mockReturnValue({...currentMockUsePanelPersistenceState});
        rerender(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />);
        vi.runAllTimers(); // For rAF
      });
      
      expect(mockLeftPanelRef.isCollapsed).toHaveBeenCalled();
      expect(mockLeftPanelRef.expand).toHaveBeenCalledTimes(1);
      expect(mockLeftPanelRef.collapse).not.toHaveBeenCalled();
    });

    it('calls leftPanelRef.collapse() when showLeftPanel becomes false and panel was expanded', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = true; // Initial state: visible
      mockLeftPanelRef.isCollapsed.mockReturnValue(false);
      mockLeftPanelRef.isExpanded.mockReturnValue(true);
      
      const { rerender } = render(
        <IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />
      );
       expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({id: 'left-panel'}), {});


      act(() => {
        currentMockUsePanelPersistenceState.showLeftPanel = false; // Toggle to hide
         vi.mocked(usePanelPersistence).mockReturnValue({...currentMockUsePanelPersistenceState});
        rerender(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />);
        vi.runAllTimers(); // For rAF
      });

      expect(mockLeftPanelRef.isExpanded).toHaveBeenCalled();
      expect(mockLeftPanelRef.collapse).toHaveBeenCalledTimes(1);
      expect(mockLeftPanelRef.expand).not.toHaveBeenCalled();
    });

    it('does not call expand() if showLeftPanel is true and panel is already expanded', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = true;
      mockLeftPanelRef.isCollapsed.mockReturnValue(false); // Already expanded
      mockLeftPanelRef.isExpanded.mockReturnValue(true);

      const { rerender } = render(
        <IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />
      );
      
      act(() => {
        // No change in showLeftPanel, but testing initial state effect too
        rerender(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />);
        vi.runAllTimers();
      });

      expect(mockLeftPanelRef.isCollapsed).toHaveBeenCalled(); // useEffect still runs
      expect(mockLeftPanelRef.expand).not.toHaveBeenCalled();
    });

    it('does not call collapse() if showLeftPanel is false and panel is already collapsed', () => {
      currentMockUsePanelPersistenceState.showLeftPanel = false;
      mockLeftPanelRef.isExpanded.mockReturnValue(false); // Already collapsed
      mockLeftPanelRef.isCollapsed.mockReturnValue(true);
      
      const { rerender } = render(
        <IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />
      );

      act(() => {
        rerender(<IdeLayout {...getBaseProps({ leftPanelContent: defaultLeftPanelContent })} />);
        vi.runAllTimers();
      });
      
      expect(mockLeftPanelRef.isExpanded).toHaveBeenCalled();
      expect(mockLeftPanelRef.collapse).not.toHaveBeenCalled();
    });
  });
});
