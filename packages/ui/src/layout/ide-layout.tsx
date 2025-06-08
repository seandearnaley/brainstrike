import { ChevronLeft, ChevronRight, PanelLeft, PanelRight, Terminal, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { Button } from '../button';
import { usePanelPersistence } from '../hooks/use-panel-persistence';
import { cn, isDevEnv } from '../lib/utils';

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
  const {
    sizes,
    showConsole,
    showLeftPanel,
    showRightPanel,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
  } = usePanelPersistence([25, 20, 30], false, !!leftPanelContent, false);

  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);

  const safeLeftSize = typeof sizes[0] === 'number' && !Number.isNaN(sizes[0]) ? sizes[0] : 25;
  const safeRightSize = typeof sizes[1] === 'number' && !Number.isNaN(sizes[1]) ? sizes[1] : 20;
  const safeConsoleSize = typeof sizes[2] === 'number' && !Number.isNaN(sizes[2]) ? sizes[2] : 30;

  useEffect(() => {
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
  }, [showLeftPanel]);

  useEffect(() => {
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
  }, [showRightPanel]);

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

  const handleConsoleClose = () => {
    toggleConsole();
  };

  return (
    <div className={cn('h-full flex-1 flex flex-col', className)}>
      <PanelGroup direction="horizontal" onLayout={handleHorizontalLayout}>
        {leftPanelContent && showLeftPanel && (
          <>
            <Panel
              ref={leftPanelRef}
              id="left-panel"
              order={1}
              defaultSize={safeLeftSize}
              minSize={15}
              maxSize={50}
              collapsible
              collapsedSize={0}
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
                    onClick={toggleLeftPanel}
                    aria-label="Hide explorer"
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                </div>
                <div className="h-[calc(100%-2.5rem)] overflow-hidden">{leftPanelContent}</div>
              </div>
            </Panel>
            <PanelResizeHandle className="w-1 bg-border hover:bg-border/80 transition-colors" />
          </>
        )}

        <Panel id="middle-panel" order={2} minSize={30}>
          <PanelGroup direction="vertical" onLayout={handleVerticalLayout}>
            <Panel id="main-content-panel" order={1} minSize={30} className="bg-background">
              <div className="h-full">{children}</div>
            </Panel>

            {showConsole && consoleContent && (
              <>
                <PanelResizeHandle className="h-1 bg-border hover:bg-border/80 transition-colors" />
                <Panel
                  id="console-panel"
                  order={2}
                  defaultSize={safeConsoleSize}
                  minSize={15}
                  maxSize={80}
                  collapsible
                  className="bg-background"
                >
                  <div className="h-full border-t border-border">
                    <div className="flex items-center justify-between p-2 border-b border-border bg-muted/30">
                      <div className="flex items-center gap-2">
                        <Terminal className="h-4 w-4" />
                        <span className="text-sm font-medium">Console</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleConsoleClose}
                        aria-label="Close console"
                      >
                        <X className="h-3 w-3" />
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
              onClick={toggleRightPanel}
              aria-label="Show right panel"
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        )}

        {rightPanelContent && showRightPanel && (
          <>
            <PanelResizeHandle className="w-1 bg-border hover:bg-border/80 transition-colors" />
            <Panel
              ref={rightPanelRef}
              id="right-panel"
              order={3}
              defaultSize={safeRightSize}
              minSize={15}
              maxSize={40}
              collapsible
              collapsedSize={0}
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
                    aria-label="Hide panel"
                  >
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
                <div className="h-[calc(100%-2.5rem)] overflow-hidden">{rightPanelContent}</div>
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>

      <div className="absolute bottom-4 right-4 z-50 flex flex-col gap-2">
        <Button
          aria-label="Show console"
          className="cursor-pointer border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 w-10 shadow-lg"
          onClick={toggleConsole}
        >
          <Terminal className="h-4 w-4" />
        </Button>
      </div>

      {leftPanelContent && !showLeftPanel && (
        <div className="absolute left-4 top-4 z-50">
          <Button
            variant="outline"
            size="icon"
            onClick={toggleLeftPanel}
            className="shadow-lg"
            aria-label="Show explorer"
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
});
