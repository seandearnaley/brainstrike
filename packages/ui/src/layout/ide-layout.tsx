import { isDevEnv } from '@brainstrike/utils';
import { ChevronLeft, ChevronRight, PanelLeft, PanelRight, Terminal, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, createContext, useContext, useMemo } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { Button } from '../button';
import { usePanelPersistence } from '../hooks/use-panel-persistence';
import { cn } from '../lib/utils';

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

  // State for managing the file editor functionality
  const [openFileInTabFn, setOpenFileInTabFn] = React.useState<
    ((compositeKey: string) => void) | null
  >(null);

  // Flag to prevent panel callbacks from saving during initial render
  const [isInitialRender, setIsInitialRender] = React.useState(true);

  // Mark initial render as complete after mount
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setIsInitialRender(false);
    }, 100); // Small delay to ensure panels are initialized
    return () => clearTimeout(timeoutId);
  }, []);

  // Stable callback so consumers don't get a new reference each render
  const registerOpenFileInTab = useCallback((fn: (compositeKey: string) => void) => {
    setOpenFileInTabFn(() => fn);
  }, []);

  // Create the context value – stable except when the implementation changes
  const fileEditorContextValue = useMemo(
    () => ({
      openFileInTab: openFileInTabFn || undefined,
      registerOpenFileInTab,
    }),
    [openFileInTabFn, registerOpenFileInTab]
  );

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

  // Focus management functions
  const handleShowLeftPanel = useCallback(() => {
    if (leftPanelRef.current) {
      leftPanelRef.current.expand();
    }
    toggleLeftPanel();
    // Focus the hide button after the panel is shown
    setTimeout(() => {
      hideExplorerButtonRef.current?.focus();
    }, 100);
  }, [toggleLeftPanel]);

  const handleHideLeftPanel = useCallback(() => {
    if (leftPanelRef.current) {
      leftPanelRef.current.collapse();
    }
    toggleLeftPanel();
  }, [toggleLeftPanel]);

  const handleShowRightPanel = useCallback(() => {
    if (rightPanelRef.current) {
      rightPanelRef.current.expand();
    }
    toggleRightPanel();
    // Focus the hide button after the panel is shown
    setTimeout(() => {
      hideRightPanelButtonRef.current?.focus();
    }, 100);
  }, [toggleRightPanel]);

  const handleShowConsole = useCallback(() => {
    if (consolePanelRef.current) {
      consolePanelRef.current.expand();
    }
    toggleConsole();
    // Focus the hide button after the console is shown
    setTimeout(() => {
      hideConsoleButtonRef.current?.focus();
    }, 100);
  }, [toggleConsole]);

  useEffect(() => {
    if (!leftPanelContent) return;
    const panel = leftPanelRef.current;
    if (panel) {
      const frameId = requestAnimationFrame(() => {
        try {
          if (showLeftPanel) {
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
      return () => cancelAnimationFrame(frameId);
    }
    return undefined;
  }, [showLeftPanel, leftPanelContent]);

  useEffect(() => {
    if (!rightPanelContent) return;
    const panel = rightPanelRef.current;
    if (panel) {
      const frameId = requestAnimationFrame(() => {
        try {
          if (showRightPanel) {
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
      return () => cancelAnimationFrame(frameId);
    }
    return undefined;
  }, [showRightPanel, rightPanelContent]);

  useEffect(() => {
    if (!consoleContent) return;
    const panel = consolePanelRef.current;
    if (panel) {
      const frameId = requestAnimationFrame(() => {
        try {
          if (showConsole) {
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
            console.warn('Console panel state operation failed:', error);
          }
        }
      });
      return () => cancelAnimationFrame(frameId);
    }
    return undefined;
  }, [showConsole, consoleContent]);

  const handleHorizontalLayout = useCallback(
    (newSizes: number[]) => {
      const hasLeft = leftPanelContent && showLeftPanel;
      const hasRight = rightPanelContent && showRightPanel;

      let newLeftSize = safeLeftSize;
      let newRightSize = safeRightSize;

      if (hasLeft && hasRight) {
        if (newSizes.length === 3) {
          newLeftSize = newSizes[0] ?? safeLeftSize;
          newRightSize = newSizes[2] ?? safeRightSize;
        }
      } else if (hasLeft) {
        if (newSizes.length === 2) {
          newLeftSize = newSizes[0] ?? safeLeftSize;
        }
      } else if (hasRight) {
        if (newSizes.length === 2) {
          newRightSize = newSizes[1] ?? safeRightSize;
        }
      }

      saveLayout([newLeftSize, newRightSize, safeConsoleSize]);
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
      if (showConsole && consoleContent && newSizes.length >= 2) {
        const consoleSize = newSizes[1] ?? safeConsoleSize;
        saveLayout([safeLeftSize, safeRightSize, consoleSize]);
      }
    },
    [showConsole, consoleContent, safeLeftSize, safeRightSize, safeConsoleSize, saveLayout]
  );

  const handleConsoleClose = useCallback(() => {
    if (consolePanelRef.current) {
      consolePanelRef.current.collapse();
    }
    toggleConsole();
  }, [toggleConsole]);

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
            <>
              <Panel
                ref={leftPanelRef}
                id="left-panel"
                data-panel-id="left-panel"
                order={1}
                defaultSize={safeLeftSize}
                minSize={15}
                maxSize={50}
                collapsible
                collapsedSize={0}
                onCollapse={() => {
                  // Prevent saving during initial render to avoid overriding localStorage state
                  if (!isInitialRender) {
                    // Sync persistence when panel is collapsed via drag or API.
                    saveLayout(
                      [0, safeRightSize, safeConsoleSize],
                      undefined,
                      false,
                      showRightPanel
                    );
                  }
                }}
                onExpand={(size?: number) => {
                  // Prevent saving during initial render to avoid overriding localStorage state
                  if (!isInitialRender) {
                    // size param may be undefined in some versions; fall back to last safe size.
                    const newSize = typeof size === 'number' ? size : safeLeftSize;
                    saveLayout(
                      [newSize, safeRightSize, safeConsoleSize],
                      undefined,
                      true,
                      showRightPanel
                    );
                  }
                }}
                className="bg-background"
              >
                <div className="h-full">
                  <div className="flex items-center justify-between px-2 py-2 border-b border-border bg-muted/30">
                    <div className="flex items-center gap-2">
                      <PanelLeft className="h-4 w-4" />
                      <span className="text-sm font-medium">Explorer</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={handleHideLeftPanel}
                      aria-label="Hide explorer"
                      ref={hideExplorerButtonRef}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="h-[calc(100%-2.5rem)] overflow-hidden">{leftPanelContent}</div>
                </div>
              </Panel>
              <PanelResizeHandle className="w-1 bg-border hover:bg-border/80 transition-colors" />
            </>
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
                <>
                  <PanelResizeHandle className="h-1 bg-border hover:bg-border/80 transition-colors" />
                  <Panel
                    ref={consolePanelRef}
                    id="console-panel"
                    data-panel-id="console-panel"
                    order={2}
                    defaultSize={safeConsoleSize}
                    minSize={15}
                    maxSize={80}
                    collapsible
                    collapsedSize={0}
                    onCollapse={() => {
                      // Prevent saving during initial render to avoid overriding localStorage state
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
                      // Prevent saving during initial render to avoid overriding localStorage state
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
                    className="bg-background"
                  >
                    <div className="h-full border-t border-border">
                      <div className="flex items-center justify-between p-2 border-b border-border bg-muted/30">
                        <div className="flex items-center gap-2">
                          <Terminal className="h-4 w-4" />
                          <span className="text-sm font-medium">File Editor</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={handleConsoleClose}
                          aria-label="Close File Editor"
                          ref={hideConsoleButtonRef}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="h-[calc(100%-2.5rem)] overflow-hidden">{consoleContent}</div>
                    </div>
                  </Panel>
                </>
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
            <>
              <PanelResizeHandle className="w-1 bg-border hover:bg-border/80 transition-colors" />
              <Panel
                ref={rightPanelRef}
                id="right-panel"
                data-panel-id="right-panel"
                order={3}
                defaultSize={safeRightSize}
                minSize={15}
                maxSize={60}
                collapsible
                collapsedSize={0}
                onCollapse={() => {
                  // Prevent saving during initial render to avoid overriding localStorage state
                  if (!isInitialRender) {
                    saveLayout([safeLeftSize, 0, safeConsoleSize], undefined, showLeftPanel, false);
                  }
                }}
                onExpand={(size?: number) => {
                  // Prevent saving during initial render to avoid overriding localStorage state
                  if (!isInitialRender) {
                    const newSize = typeof size === 'number' ? size : safeRightSize;
                    saveLayout(
                      [safeLeftSize, newSize, safeConsoleSize],
                      undefined,
                      showLeftPanel,
                      true
                    );
                  }
                }}
                className="bg-background"
              >
                <div className="h-full border-l border-border">
                  <div className="flex items-center justify-between p-2 border-b border-border bg-muted/30">
                    <div className="flex items-center gap-2">
                      <PanelRight className="h-4 w-4" />
                      <span className="text-sm font-medium">Panel</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={toggleRightPanel}
                      aria-label="Hide right panel"
                      ref={hideRightPanelButtonRef}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="h-[calc(100%-2.5rem)] overflow-hidden">{rightPanelContent}</div>
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>

        <div className="absolute bottom-4 right-4 z-50 flex flex-col gap-2">
          {/* Floating buttons can be placed here if needed in the future */}
        </div>
      </div>
    </IdeFileEditorContext.Provider>
  );
});
