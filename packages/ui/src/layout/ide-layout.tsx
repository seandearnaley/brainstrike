import { isDevEnv } from '@brainstrike/utils';
import { ChevronLeft, ChevronRight, Terminal } from 'lucide-react';
import React, { useCallback, useEffect, useRef, createContext, useContext, useMemo } from 'react';
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

// Helper function to sync panel state with imperative panel handle
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
    } catch (error) {
      if (isDevEnv()) {
        console.warn('Panel state operation failed:', error);
      }
    }
  });

  // Return cleanup function
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

// Custom hook for managing layout change handlers
function useLayoutHandlers(
  leftPanelContent?: React.ReactNode,
  rightPanelContent?: React.ReactNode,
  consoleContent?: React.ReactNode,
  showLeftPanel?: boolean,
  showRightPanel?: boolean,
  showConsole?: boolean,
  safeLeftSize?: number,
  safeRightSize?: number,
  safeConsoleSize?: number,
  saveLayout?: (
    sizes: number[],
    showConsole?: boolean,
    showLeftPanel?: boolean,
    showRightPanel?: boolean
  ) => void
) {
  const handleHorizontalLayout = useCallback(
    (newSizes: number[]) => {
      if (!saveLayout) return;

      const hasLeft = leftPanelContent && showLeftPanel;
      const hasRight = rightPanelContent && showRightPanel;

      let newLeftSize = safeLeftSize ?? 25;
      let newRightSize = safeRightSize ?? 20;

      if (hasLeft && hasRight) {
        if (newSizes.length === 3) {
          newLeftSize = newSizes[0] ?? newLeftSize;
          newRightSize = newSizes[2] ?? newRightSize;
        }
      } else if (hasLeft) {
        if (newSizes.length === 2) {
          newLeftSize = newSizes[0] ?? newLeftSize;
        }
      } else if (hasRight) {
        if (newSizes.length === 2) {
          newRightSize = newSizes[1] ?? newRightSize;
        }
      }

      saveLayout([newLeftSize, newRightSize, safeConsoleSize ?? 20]);
    },
    [
      leftPanelContent,
      showLeftPanel,
      rightPanelContent,
      showRightPanel,
      safeLeftSize,
      safeRightSize,
      safeConsoleSize,
      saveLayout,
    ]
  );

  const handleVerticalLayout = useCallback(
    (newSizes: number[]) => {
      if (!saveLayout) return;

      if (showConsole && consoleContent && newSizes.length >= 2) {
        const consoleSize = newSizes[1] ?? safeConsoleSize ?? 20;
        saveLayout([safeLeftSize ?? 25, safeRightSize ?? 20, consoleSize]);
      }
    },
    [showConsole, consoleContent, safeLeftSize, safeRightSize, safeConsoleSize, saveLayout]
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
  const [isInitialRender, setIsInitialRender] = React.useState(true);

  // Mark initial render as complete after mount
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setIsInitialRender(false);
    }, 100); // Small delay to ensure panels are initialized
    return () => clearTimeout(timeoutId);
  }, []);

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

  const { show: handleShowLeftPanel, hide: handleHideLeftPanel } = usePanelToggle(
    leftPanelRef,
    toggleLeftPanel,
    {
      focusRef: hideExplorerButtonRef,
    }
  );

  const { show: handleShowRightPanel, hide: handleHideRightPanel } = usePanelToggle(
    rightPanelRef,
    toggleRightPanel,
    {
      focusRef: hideRightPanelButtonRef,
    }
  );

  const { show: handleShowConsole, hide: handleConsoleClose } = usePanelToggle(
    consolePanelRef,
    toggleConsole,
    {
      focusRef: hideConsoleButtonRef,
    }
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
  const { handleHorizontalLayout, handleVerticalLayout } = useLayoutHandlers(
    leftPanelContent,
    rightPanelContent,
    consoleContent,
    showLeftPanel,
    showRightPanel,
    showConsole,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
    saveLayout
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
              onCollapse={() => {
                if (!isInitialRender) {
                  saveLayout([0, safeRightSize, safeConsoleSize], undefined, false, showRightPanel);
                }
              }}
              onExpand={(size?: number) => {
                if (!isInitialRender) {
                  const newSize = typeof size === 'number' ? size : safeLeftSize;
                  saveLayout(
                    [newSize, safeRightSize, safeConsoleSize],
                    undefined,
                    true,
                    showRightPanel
                  );
                }
              }}
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
                  onCollapse={() => {
                    if (!isInitialRender) {
                      saveLayout(
                        [safeLeftSize, safeRightSize, 0],
                        false,
                        showLeftPanel,
                        showRightPanel
                      );
                    }
                  }}
                  onExpand={(size?: number) => {
                    if (!isInitialRender) {
                      const newSize = typeof size === 'number' ? size : safeConsoleSize;
                      saveLayout(
                        [safeLeftSize, safeRightSize, newSize],
                        true,
                        showLeftPanel,
                        showRightPanel
                      );
                    }
                  }}
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
              onCollapse={() => {
                if (!isInitialRender) {
                  saveLayout([safeLeftSize, 0, safeConsoleSize], showConsole, showLeftPanel, false);
                }
              }}
              onExpand={(size?: number) => {
                if (!isInitialRender) {
                  const newSize = typeof size === 'number' ? size : safeRightSize;
                  saveLayout(
                    [safeLeftSize, newSize, safeConsoleSize],
                    showConsole,
                    showLeftPanel,
                    true
                  );
                }
              }}
            />
          )}
        </PanelGroup>
      </div>
    </IdeFileEditorContext.Provider>
  );
});
