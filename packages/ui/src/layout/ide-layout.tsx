import { isDevEnv } from '@brainstrike/utils';
import { ChevronLeft, ChevronRight, Terminal } from 'lucide-react';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { type ImperativePanelHandle, Panel, PanelGroup } from 'react-resizable-panels';
import { Button } from '../button';
import { usePanelPersistence } from '../hooks/use-panel-persistence';
import { usePanelToggle } from '../hooks/use-panel-toggle';
import { cn } from '../lib/utils';
import { ConsolePanel } from './console-panel';
import { LeftPanel } from './left-panel';
import { RightPanel } from './right-panel';

// Context for sharing file editor functionality between main content and console
interface FileEditorContextValue {
  openFileInTab: ((compositeKey: string) => void) | undefined;
  registerOpenFileInTab: (fn: (compositeKey: string) => void) => void;
}

const IdeFileEditorContext = createContext<FileEditorContextValue>({
  openFileInTab: undefined,
  registerOpenFileInTab: () => {},
});

export const useIdeFileEditor = () => useContext(IdeFileEditorContext);

// Panel state synchronization helper
function syncPanelState(
  panel: ImperativePanelHandle | null,
  shouldShow: boolean,
  hasContent: boolean
): (() => void) | undefined {
  if (!hasContent || !panel) return;

  const frameId = requestAnimationFrame(() => {
    try {
      if (shouldShow) {
        if (panel.isCollapsed()) {
          panel.expand();
        }
      } else {
        if (panel.isExpanded()) {
          panel.collapse();
        }
      }
    } catch (_error) {
      if (isDevEnv()) {
      }
    }
  });

  return () => cancelAnimationFrame(frameId);
}

// Custom hook for managing panel state effects
function usePanelEffects(
  leftPanelRef: React.RefObject<ImperativePanelHandle | null>,
  rightPanelRef: React.RefObject<ImperativePanelHandle | null>,
  consolePanelRef: React.RefObject<ImperativePanelHandle | null>,
  showLeftPanel: boolean,
  showRightPanel: boolean,
  showConsole: boolean,
  leftPanelContent?: React.ReactNode,
  rightPanelContent?: React.ReactNode,
  consoleContent?: React.ReactNode
) {
  useEffect(() => {
    return syncPanelState(leftPanelRef.current, showLeftPanel, !!leftPanelContent);
  }, [showLeftPanel, leftPanelContent, leftPanelRef]);

  useEffect(() => {
    return syncPanelState(rightPanelRef.current, showRightPanel, !!rightPanelContent);
  }, [showRightPanel, rightPanelContent, rightPanelRef]);

  useEffect(() => {
    return syncPanelState(consolePanelRef.current, showConsole, !!consoleContent);
  }, [showConsole, consoleContent, consolePanelRef]);
}

// Layout handler configuration
interface LayoutHandlerConfig {
  leftPanelContent?: React.ReactNode;
  rightPanelContent?: React.ReactNode;
  consoleContent?: React.ReactNode;
  showLeftPanel?: boolean;
  showRightPanel?: boolean;
  showConsole?: boolean;
  safeLeftSize?: number;
  safeRightSize?: number;
  safeConsoleSize?: number;
  saveLayout?: (
    sizes: number[],
    showConsole?: boolean,
    showLeftPanel?: boolean,
    showRightPanel?: boolean
  ) => void;
}

// Helper to determine panel visibility state
function getPanelVisibilityState(config: LayoutHandlerConfig) {
  return {
    hasLeft: config.leftPanelContent && config.showLeftPanel,
    hasRight: config.rightPanelContent && config.showRightPanel,
  };
}

// Helper to get size from array with fallback
function getSizeWithFallback(sizes: number[], index: number, fallback: number): number {
  return sizes[index] ?? fallback;
}

// Horizontal layout size calculation
function calculateHorizontalSizes(
  newSizes: number[],
  config: LayoutHandlerConfig
): [number, number] {
  const { hasLeft, hasRight } = getPanelVisibilityState(config);
  const defaultLeftSize = config.safeLeftSize ?? 25;
  const defaultRightSize = config.safeRightSize ?? 20;

  // Both panels visible - expect 3 sizes [left, middle, right]
  if (hasLeft && hasRight && newSizes.length === 3) {
    return [
      getSizeWithFallback(newSizes, 0, defaultLeftSize),
      getSizeWithFallback(newSizes, 2, defaultRightSize),
    ];
  }

  // Only left panel visible - expect 2 sizes [left, middle]
  if (hasLeft && newSizes.length === 2) {
    return [getSizeWithFallback(newSizes, 0, defaultLeftSize), defaultRightSize];
  }

  // Only right panel visible - expect 2 sizes [middle, right]
  if (hasRight && newSizes.length === 2) {
    return [defaultLeftSize, getSizeWithFallback(newSizes, 1, defaultRightSize)];
  }

  // Fallback to defaults for all other cases
  return [defaultLeftSize, defaultRightSize];
}

// Custom hook for managing layout change handlers
function useLayoutHandlers(config: LayoutHandlerConfig) {
  const handleHorizontalLayout = useCallback(
    (newSizes: number[]) => {
      if (!config.saveLayout) return;

      const [newLeftSize, newRightSize] = calculateHorizontalSizes(newSizes, config);
      config.saveLayout([newLeftSize, newRightSize, config.safeConsoleSize ?? 20]);
    },
    [config]
  );

  const handleVerticalLayout = useCallback(
    (newSizes: number[]) => {
      if (!config.saveLayout) return;

      if (config.showConsole && config.consoleContent && newSizes.length >= 2) {
        const consoleSize = newSizes[1] ?? config.safeConsoleSize ?? 20;
        config.saveLayout([config.safeLeftSize ?? 25, config.safeRightSize ?? 20, consoleSize]);
      }
    },
    [config]
  );

  return { handleHorizontalLayout, handleVerticalLayout };
}

// Custom hook for managing file editor context
function useFileEditorContext() {
  const [openFileInTabFn, setOpenFileInTabFn] = React.useState<
    ((compositeKey: string) => void) | null
  >(null);

  const registerOpenFileInTab = useCallback((fn: (compositeKey: string) => void) => {
    setOpenFileInTabFn(() => fn);
  }, []);

  const fileEditorContextValue = useMemo(
    () => ({
      openFileInTab: openFileInTabFn || undefined,
      registerOpenFileInTab,
    }),
    [openFileInTabFn, registerOpenFileInTab]
  );

  return fileEditorContextValue;
}

// Panel collapse/expand handler factory
function createPanelHandler(
  isInitialRenderRef: React.MutableRefObject<boolean>,
  saveLayout: (
    sizes: number[],
    showConsole?: boolean,
    showLeftPanel?: boolean,
    showRightPanel?: boolean
  ) => void,
  sizes: [number, number, number],
  panelType: 'left' | 'right' | 'console'
) {
  const [safeLeftSize, safeRightSize, safeConsoleSize] = sizes;

  return {
    onCollapse: () => {
      if (isInitialRenderRef.current) return;

      switch (panelType) {
        case 'left':
          saveLayout([0, safeRightSize, safeConsoleSize], undefined, false, undefined);
          break;
        case 'right':
          saveLayout([safeLeftSize, 0, safeConsoleSize], undefined, undefined, false);
          break;
        case 'console':
          saveLayout([safeLeftSize, safeRightSize, 0], false, undefined, undefined);
          break;
      }
    },
    onExpand: (size?: number) => {
      if (isInitialRenderRef.current) return;

      const newSize =
        typeof size === 'number'
          ? size
          : sizes[panelType === 'left' ? 0 : panelType === 'right' ? 1 : 2];

      switch (panelType) {
        case 'left':
          saveLayout([newSize, safeRightSize, safeConsoleSize], undefined, true, undefined);
          break;
        case 'right':
          saveLayout([safeLeftSize, newSize, safeConsoleSize], undefined, undefined, true);
          break;
        case 'console':
          saveLayout([safeLeftSize, safeRightSize, newSize], true, undefined, undefined);
          break;
      }
    },
  };
}

export interface IdeLayoutProps {
  children: React.ReactNode;
  leftPanelContent?: React.ReactNode;
  rightPanelContent?: React.ReactNode;
  consoleContent?: React.ReactNode;
  className?: string;
}

export const IdeLayout = React.memo(function IdeLayout({
  children,
  leftPanelContent,
  rightPanelContent,
  consoleContent,
  className,
}: IdeLayoutProps) {
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const consolePanelRef = useRef<ImperativePanelHandle>(null);

  // Flag to prevent panel callbacks from saving during initial render
  // Use a ref to avoid re-renders and make this more deterministic
  const isInitialRenderRef = useRef(true);
  const panelsInitializedRef = useRef(false);

  // Mark initial render as complete once panels are actually initialized
  // This is more deterministic than using a timeout
  useEffect(() => {
    // Check if all panels are initialized
    const checkPanelsInitialized = () => {
      const hasLeftPanel = !leftPanelContent || leftPanelRef.current !== null;
      const hasRightPanel = !rightPanelContent || rightPanelRef.current !== null;
      const hasConsolePanel = !consoleContent || consolePanelRef.current !== null;

      return hasLeftPanel && hasRightPanel && hasConsolePanel;
    };

    if (!panelsInitializedRef.current && checkPanelsInitialized()) {
      panelsInitializedRef.current = true;
      // Use a shorter delay to allow panel state to settle
      // but not as long as the original 100ms timeout
      setTimeout(() => {
        isInitialRenderRef.current = false;
      }, 16); // One frame at 60fps
    }
  });

  // File editor context management
  const fileEditorContextValue = useFileEditorContext();

  // Add refs for focus management
  const hideExplorerButtonRef = useRef<HTMLButtonElement>(null);
  const hideRightPanelButtonRef = useRef<HTMLButtonElement>(null);
  const hideConsoleButtonRef = useRef<HTMLButtonElement>(null);

  const {
    sizes,
    showConsole,
    showLeftPanel,
    showRightPanel,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
  } = usePanelPersistence([25, 55, 20], false, !!leftPanelContent, false);

  const [safeLeftSize, safeRightSize, safeConsoleSize] = [
    typeof sizes[0] === 'number' && !Number.isNaN(sizes[0]) ? sizes[0] : 25,
    typeof sizes[1] === 'number' && !Number.isNaN(sizes[1]) ? sizes[1] : 55,
    typeof sizes[2] === 'number' && !Number.isNaN(sizes[2]) ? sizes[2] : 20,
  ];

  const safeSizes: [number, number, number] = [safeLeftSize, safeRightSize, safeConsoleSize];

  const { show: handleShowLeftPanel, hide: handleHideLeftPanel } = usePanelToggle(
    leftPanelRef,
    toggleLeftPanel,
    { focusRef: hideExplorerButtonRef }
  );

  const { show: handleShowRightPanel, hide: handleHideRightPanel } = usePanelToggle(
    rightPanelRef,
    toggleRightPanel,
    { focusRef: hideRightPanelButtonRef }
  );

  const { show: handleShowConsole, hide: handleConsoleClose } = usePanelToggle(
    consolePanelRef,
    toggleConsole,
    { focusRef: hideConsoleButtonRef }
  );

  // Panel state effects
  usePanelEffects(
    leftPanelRef,
    rightPanelRef,
    consolePanelRef,
    showLeftPanel,
    showRightPanel,
    showConsole,
    leftPanelContent,
    rightPanelContent,
    consoleContent
  );

  // Layout handlers
  const layoutConfig: LayoutHandlerConfig = {
    leftPanelContent,
    rightPanelContent,
    consoleContent,
    showLeftPanel,
    showRightPanel,
    showConsole,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
    saveLayout,
  };

  const { handleHorizontalLayout, handleVerticalLayout } = useLayoutHandlers(layoutConfig);

  // Panel handlers
  const leftPanelHandlers = createPanelHandler(isInitialRenderRef, saveLayout, safeSizes, 'left');
  const rightPanelHandlers = createPanelHandler(isInitialRenderRef, saveLayout, safeSizes, 'right');
  const consolePanelHandlers = createPanelHandler(
    isInitialRenderRef,
    saveLayout,
    safeSizes,
    'console'
  );

  return (
    <IdeFileEditorContext.Provider value={fileEditorContextValue}>
      <div className={cn('h-full flex-1 flex flex-col', className)}>
        <PanelGroup direction="horizontal" onLayout={handleHorizontalLayout}>
          {!showLeftPanel && leftPanelContent && (
            <div className="flex items-center justify-center p-2 border-r border-border bg-muted/30">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleShowLeftPanel}
                aria-label="Show explorer"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          {leftPanelContent && (
            <LeftPanel
              panelRef={leftPanelRef}
              content={leftPanelContent}
              hideButtonRef={hideExplorerButtonRef}
              onHide={handleHideLeftPanel}
              defaultSize={safeLeftSize}
              {...leftPanelHandlers}
            />
          )}

          <Panel id="middle-panel" data-panel-id="middle-panel" order={2} minSize={30}>
            <PanelGroup direction="vertical" onLayout={handleVerticalLayout}>
              <Panel
                id="main-content-panel"
                data-panel-id="main-content-panel"
                order={1}
                minSize={30}
                className="bg-background"
              >
                <div className="h-full">{children}</div>
              </Panel>

              {!showConsole && consoleContent && (
                <div className="flex items-center justify-center py-1 border-t border-border bg-muted/30">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6"
                    onClick={handleShowConsole}
                    aria-label="Show File Editor"
                  >
                    <Terminal className="h-4 w-4" />
                    <span className="ml-2 text-xs">Show File Editor</span>
                  </Button>
                </div>
              )}
              {consoleContent && (
                <ConsolePanel
                  panelRef={consolePanelRef}
                  content={consoleContent}
                  hideButtonRef={hideConsoleButtonRef}
                  onHide={handleConsoleClose}
                  defaultSize={safeConsoleSize}
                  {...consolePanelHandlers}
                />
              )}
            </PanelGroup>
          </Panel>

          {!showRightPanel && rightPanelContent && (
            <div className="flex items-center justify-center p-2 border-l border-border bg-muted/30">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleShowRightPanel}
                aria-label="Show right panel"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>
          )}
          {rightPanelContent && (
            <RightPanel
              panelRef={rightPanelRef}
              content={rightPanelContent}
              hideButtonRef={hideRightPanelButtonRef}
              onHide={handleHideRightPanel}
              defaultSize={safeRightSize}
              {...rightPanelHandlers}
            />
          )}
        </PanelGroup>
      </div>
    </IdeFileEditorContext.Provider>
  );
});
