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
import { cn } from '../lib/utils';
import { NavigationSidebar } from '../navigation-sidebar';
import type { NavigationItem } from '../navigation-sidebar';

export interface IdeLayoutProps {
  children: React.ReactNode;
  navigationItems: NavigationItem[];
  currentPath: string;
  onNavigationClick?: (path: string) => void;
  leftPanelContent?: React.ReactNode;
  rightPanelContent?: React.ReactNode;
  consoleContent?: React.ReactNode;
  navigationChildren?: React.ReactNode;
  className?: string;
}

export const IdeLayout = React.memo(function IdeLayout({
  children,
  navigationItems,
  currentPath,
  onNavigationClick,
  leftPanelContent,
  rightPanelContent,
  consoleContent,
  navigationChildren,
  className,
}: IdeLayoutProps) {
  // Panel persistence with default sizes: [left: 25%, right: 20%, console: 30%]
  const {
    sizes,
    showConsole,
    showLeftPanel,
    showRightPanel,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
  } = usePanelPersistence([25, 20, 30], false, !!leftPanelContent, !!rightPanelContent);

  const leftPanelRef = useRef<ImperativePanelHandle>(null);

  // Ensure sizes are always valid numbers with proper fallbacks
  const safeLeftSize = typeof sizes[0] === 'number' && !Number.isNaN(sizes[0]) ? sizes[0] : 25;
  const safeRightSize = typeof sizes[1] === 'number' && !Number.isNaN(sizes[1]) ? sizes[1] : 20;
  const safeConsoleSize = typeof sizes[2] === 'number' && !Number.isNaN(sizes[2]) ? sizes[2] : 30;

  // Effect to imperatively collapse/expand the left panel
  useEffect(() => {
    const panel = leftPanelRef.current;
    if (panel) {
      // Add a small delay to ensure panels are properly initialized
      const timeoutId = setTimeout(() => {
        try {
          if (showLeftPanel) {
            if (panel.isCollapsed()) {
              panel.expand();
            }
            // Optional: If expand doesn't restore to a good size, explicitly set it.
            // const targetSize = sizes[0] || 25;
            // if (panel.getSize() !== targetSize) {
            // panel.resize(targetSize);
            // }
          } else {
            if (panel.isExpanded()) {
              panel.collapse();
            }
          }
        } catch (error) {
          // Ignore panel state errors in test environments
          console.warn('Panel state operation failed:', error);
        }
      }, 0);

      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [showLeftPanel]); // Removed sizes from dependency array

  const handleHorizontalLayout = useCallback(
    (newSizes: number[]) => {
      // For horizontal layout: [left, middle+right, console]
      // We need to preserve the right panel size within the middle+right section
      if (newSizes.length >= 2 && newSizes[0] !== undefined && newSizes[2] !== undefined) {
        saveLayout([newSizes[0], safeRightSize, newSizes[2]]);
      }
    },
    [safeRightSize, saveLayout]
  );

  const handleVerticalLayout = useCallback(
    (newSizes: number[]) => {
      // For vertical layout within main content: [middle, right]
      if (newSizes.length >= 2 && newSizes[0] !== undefined && newSizes[1] !== undefined) {
        saveLayout([safeLeftSize, newSizes[1], safeConsoleSize]);
      }
    },
    [safeLeftSize, safeConsoleSize, saveLayout]
  );

  const handleConsoleClose = () => {
    toggleConsole();
  };

  return (
    <div className={cn('h-screen flex', className)}>
      {/* Navigation Sidebar */}
      <NavigationSidebar
        items={navigationItems}
        currentPath={currentPath}
        {...(onNavigationClick && { onItemClick: onNavigationClick })}
      >
        {navigationChildren}
      </NavigationSidebar>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col">
        <PanelGroup direction="horizontal" onLayout={handleHorizontalLayout}>
          {/* Left Panel - File Tree */}
          {leftPanelContent && (
            <>
              <Panel
                ref={leftPanelRef}
                id="left-panel"
                order={1}
                defaultSize={safeLeftSize}
                minSize={15}
                collapsible
                collapsedSize={0}
                className={cn(
                  'bg-background',
                  !showLeftPanel && 'overflow-hidden !min-w-0 !w-0 !border-transparent'
                )}
              >
                <div className={cn('h-full', !showLeftPanel && 'hidden')}>
                  <div className="flex items-center justify-between p-2 border-b border-border bg-muted/30">
                    <div className="flex items-center gap-2">
                      <PanelLeft className="h-4 w-4" />
                      <span className="text-sm font-medium">Explorer</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={toggleLeftPanel}
                      aria-label={showLeftPanel ? 'Hide explorer' : 'Show explorer'}
                    >
                      {showLeftPanel ? (
                        <ChevronLeft className="h-3 w-3" />
                      ) : (
                        <PanelLeft className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <div className="h-[calc(100%-2.5rem)] overflow-hidden">{leftPanelContent}</div>
                </div>
              </Panel>
              <PanelResizeHandle
                className={cn(
                  'w-1 bg-border hover:bg-border/80 transition-colors',
                  !showLeftPanel && 'hidden'
                )}
              />
            </>
          )}

          {/* Main Content Panel */}
          <Panel id="main-panel" order={2} minSize={40}>
            <PanelGroup direction="vertical">
              {/* Main Content */}
              <Panel
                id="main-content-panel"
                order={1}
                defaultSize={showConsole ? 70 : 100}
                minSize={showConsole ? 40 : 60}
              >
                {rightPanelContent && showRightPanel ? (
                  <PanelGroup direction="horizontal" onLayout={handleVerticalLayout}>
                    {/* Middle Panel - Editor/Preview */}
                    <Panel
                      id="middle-panel"
                      order={1}
                      defaultSize={80 - safeRightSize}
                      minSize={40}
                      className="bg-background"
                    >
                      <div className="h-full">{children}</div>
                    </Panel>

                    <PanelResizeHandle className="w-1 bg-border hover:bg-border/80 transition-colors" />

                    {/* Right Panel - Sidebar */}
                    <Panel
                      id="right-panel"
                      order={2}
                      defaultSize={safeRightSize}
                      minSize={15}
                      maxSize={40}
                      collapsible
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
                        <div className="h-[calc(100%-2.5rem)] overflow-hidden">
                          {rightPanelContent}
                        </div>
                      </div>
                    </Panel>
                  </PanelGroup>
                ) : (
                  <div className="h-full bg-background">{children}</div>
                )}
              </Panel>

              {/* Console Panel */}
              {showConsole && consoleContent && (
                <>
                  <PanelResizeHandle className="h-1 bg-border hover:bg-border/80 transition-colors" />
                  <Panel
                    id="console-panel"
                    order={2}
                    defaultSize={safeConsoleSize}
                    minSize={15}
                    maxSize={60}
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
                      <div className="h-[calc(100%-2.5rem)] overflow-hidden">
                        {consoleContent || (
                          <div className="p-4 text-sm text-muted-foreground">
                            Console output will appear here...
                          </div>
                        )}
                      </div>
                    </div>
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>
        </PanelGroup>

        {/* Floating Toggle Buttons */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-2">
          {/* Console Toggle Button (when console is hidden) */}
          {!showConsole && consoleContent && (
            <Button
              variant="outline"
              size="icon"
              onClick={toggleConsole}
              className="shadow-lg"
              aria-label="Show console"
            >
              <Terminal className="h-4 w-4" />
            </Button>
          )}

          {/* Right Panel Toggle Button (when right panel is hidden) */}
          {rightPanelContent && !showRightPanel && (
            <Button
              variant="outline"
              size="icon"
              onClick={toggleRightPanel}
              className="shadow-lg"
              aria-label="Show right panel"
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Left Panel Toggle Button (when left panel is hidden) */}
        {leftPanelContent && !showLeftPanel && (
          <div className="absolute top-4 left-4">
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
    </div>
  );
});
