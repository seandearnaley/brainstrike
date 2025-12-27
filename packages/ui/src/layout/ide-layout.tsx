import { createLogger, isDevEnv } from '@brainstrike/utils';
import { ChevronLeft, ChevronRight, Terminal } from 'lucide-react';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { type ImperativePanelHandle, Panel, PanelGroup } from 'react-resizable-panels';
import { Button } from '../button';
import type { PanelPersistenceAdapter } from '../hooks/panel-persistence-adapters';
import { usePanelPersistence } from '../hooks/use-panel-persistence';
// Phase 3: no internal persistence fallback; require provider/controlled usage
import { usePanelToggle } from '../hooks/use-panel-toggle';
import { cn } from '../lib/utils';
import { usePanelLayout } from '../providers/panel-layout-provider';
import { ConsolePanel } from './console-panel';
import { ExplorerPanel } from './explorer-panel';
import { ToolsPanel } from './tools-panel';

const logger = createLogger('IdeLayout');

// Context for sharing file editor functionality between main content and console
type FileEditorContextValue = {
  openFileInTab: ((compositeKey: string) => void) | undefined;
  registerOpenFileInTab: (fn: (compositeKey: string) => void) => void;
};

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
  if (!(hasContent && panel)) {
    return;
  }

  const frameId = requestAnimationFrame(() => {
    try {
      if (shouldShow) {
        if (panel.isCollapsed()) {
          panel.expand();
        }
      } else if (panel.isExpanded()) {
        panel.collapse();
      }
    } catch (error) {
      if (isDevEnv()) {
        logger.debug('Failed to sync panel state', {
          error,
          shouldShow,
          hasContent,
          panelCollapsed: panel?.isCollapsed?.(),
          panelExpanded: panel?.isExpanded?.(),
        });
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
  useEffect(
    () => syncPanelState(leftPanelRef.current, showLeftPanel, !!leftPanelContent),
    [showLeftPanel, leftPanelContent, leftPanelRef]
  );

  useEffect(
    () => syncPanelState(rightPanelRef.current, showRightPanel, !!rightPanelContent),
    [showRightPanel, rightPanelContent, rightPanelRef]
  );

  useEffect(
    () => syncPanelState(consolePanelRef.current, showConsole, !!consoleContent),
    [showConsole, consoleContent, consolePanelRef]
  );
}

// Layout handler configuration
type LayoutHandlerConfig = {
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
};

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

  // Only explorer panel visible - expect 2 sizes [left, middle]
  if (hasLeft && newSizes.length === 2) {
    return [getSizeWithFallback(newSizes, 0, defaultLeftSize), defaultRightSize];
  }

  // Only tools panel visible - expect 2 sizes [middle, right]
  if (hasRight && newSizes.length === 2) {
    return [defaultLeftSize, getSizeWithFallback(newSizes, 1, defaultRightSize)];
  }

  // Fallback to defaults for all other cases
  return [defaultLeftSize, defaultRightSize];
}

function buildLayoutHandlerConfig(config: LayoutHandlerConfig): LayoutHandlerConfig {
  const cfg: LayoutHandlerConfig = {};
  if (config.leftPanelContent !== undefined) {
    cfg.leftPanelContent = config.leftPanelContent;
  }
  if (config.rightPanelContent !== undefined) {
    cfg.rightPanelContent = config.rightPanelContent;
  }
  if (config.consoleContent !== undefined) {
    cfg.consoleContent = config.consoleContent;
  }
  if (typeof config.showLeftPanel === 'boolean') {
    cfg.showLeftPanel = config.showLeftPanel;
  }
  if (typeof config.showRightPanel === 'boolean') {
    cfg.showRightPanel = config.showRightPanel;
  }
  if (typeof config.showConsole === 'boolean') {
    cfg.showConsole = config.showConsole;
  }
  if (config.safeLeftSize !== undefined) {
    cfg.safeLeftSize = config.safeLeftSize;
  }
  if (config.safeRightSize !== undefined) {
    cfg.safeRightSize = config.safeRightSize;
  }
  if (config.safeConsoleSize !== undefined) {
    cfg.safeConsoleSize = config.safeConsoleSize;
  }
  if (config.saveLayout) {
    cfg.saveLayout = config.saveLayout;
  }
  return cfg;
}

// Custom hook for managing layout change handlers
function useLayoutHandlers(config: LayoutHandlerConfig) {
  const stableConfig = useMemo<LayoutHandlerConfig>(
    () => buildLayoutHandlerConfig(config),
    [
      config.leftPanelContent,
      config.rightPanelContent,
      config.consoleContent,
      config.showLeftPanel,
      config.showRightPanel,
      config.showConsole,
      config.safeLeftSize,
      config.safeRightSize,
      config.safeConsoleSize,
      config.saveLayout,
    ]
  );

  const handleHorizontalLayout = useCallback(
    (newSizes: number[]) => {
      if (!stableConfig.saveLayout) {
        return;
      }

      const [newLeftSize, newRightSize] = calculateHorizontalSizes(newSizes, stableConfig);
      stableConfig.saveLayout(
        [newLeftSize, newRightSize, stableConfig.safeConsoleSize ?? 20],
        !!stableConfig.showConsole,
        !!stableConfig.showLeftPanel,
        !!stableConfig.showRightPanel
      );
    },
    [stableConfig]
  );

  const handleVerticalLayout = useCallback(
    (newSizes: number[]) => {
      if (!stableConfig.saveLayout) {
        return;
      }

      if (stableConfig.showConsole && stableConfig.consoleContent && newSizes.length >= 2) {
        const consoleSize = newSizes[1] ?? stableConfig.safeConsoleSize ?? 20;
        stableConfig.saveLayout(
          [stableConfig.safeLeftSize ?? 25, stableConfig.safeRightSize ?? 20, consoleSize],
          !!stableConfig.showConsole,
          !!stableConfig.showLeftPanel,
          !!stableConfig.showRightPanel
        );
      }
    },
    [stableConfig]
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
      if (isInitialRenderRef.current) {
        return;
      }

      switch (panelType) {
        case 'left':
          // Keep last known size so restore works; just flip visibility
          saveLayout([safeLeftSize, safeRightSize, safeConsoleSize], undefined, false, undefined);
          break;
        case 'right':
          saveLayout([safeLeftSize, safeRightSize, safeConsoleSize], undefined, undefined, false);
          break;
        case 'console':
          saveLayout([safeLeftSize, safeRightSize, safeConsoleSize], false, undefined, undefined);
          break;
      }
    },
    onExpand: (size?: number) => {
      if (isInitialRenderRef.current) {
        return;
      }

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

// Resolve panel state from provider if present, otherwise use internal persistence
function useResolvedPanelState(leftPanelContent?: React.ReactNode) {
  const ctx = usePanelLayout();
  // In dev, enforce explicit provider wiring and avoid invoking fallback persistence at all
  if (!ctx && isDevEnv()) {
    throw new Error('Missing PanelLayoutProvider');
  }

  // Always call fallback hook to preserve rules-of-hooks ordering.
  // In dev, provide a noop adapter to satisfy strict adapter requirements without side effects.
  const noopAdapter: PanelPersistenceAdapter = useMemo(
    () => ({
      load: async () => null,
      save: async () => {},
      flush: async () => {},
    }),
    []
  );
  const fallback = usePanelPersistence(
    [25, 55, 20],
    false,
    !!leftPanelContent,
    false,
    isDevEnv() ? noopAdapter : null
  );

  if (ctx) {
    const sizes = ctx.sizes;
    const showConsole = ctx.showConsole;
    const showLeftPanel = ctx.showLeftPanel;
    const showRightPanel = ctx.showRightPanel;

    const saveLayout = (
      newSizes: number[],
      sConsole?: boolean,
      sLeft?: boolean,
      sRight?: boolean
    ) =>
      ctx.setState({
        sizes: newSizes,
        showConsole: sConsole ?? ctx.showConsole,
        showLeftPanel: sLeft ?? ctx.showLeftPanel,
        showRightPanel: sRight ?? ctx.showRightPanel,
      });

    const toggleConsole = () =>
      ctx.setState({
        sizes,
        showConsole: !showConsole,
        showLeftPanel,
        showRightPanel,
      });

    const toggleLeftPanel = () =>
      ctx.setState({
        sizes,
        showConsole,
        showLeftPanel: !showLeftPanel,
        showRightPanel,
      });

    const toggleRightPanel = () =>
      ctx.setState({
        sizes,
        showConsole,
        showLeftPanel,
        showRightPanel: !showRightPanel,
      });

    return {
      sizes,
      showConsole,
      showLeftPanel,
      showRightPanel,
      saveLayout,
      toggleConsole,
      toggleLeftPanel,
      toggleRightPanel,
    } as const;
  }

  return fallback;
}

export type IdeLayoutProps = {
  children: React.ReactNode;
  leftPanelContent?: React.ReactNode;
  rightPanelContent?: React.ReactNode;
  consoleContent?: React.ReactNode;
  className?: string;
};

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
      const hasLeftPanel = !(leftPanelContent && showLeftPanel) || leftPanelRef.current !== null;
      const hasRightPanel =
        !(rightPanelContent && showRightPanel) || rightPanelRef.current !== null;
      const hasConsolePanel = !(consoleContent && showConsole) || consolePanelRef.current !== null;

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
  const hideToolsPanelButtonRef = useRef<HTMLButtonElement>(null);
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
  } = useResolvedPanelState(leftPanelContent);

  const [safeLeftSize, safeRightSize, safeConsoleSize] = [
    typeof sizes[0] === 'number' && !Number.isNaN(sizes[0]) ? sizes[0] : 25,
    typeof sizes[1] === 'number' && !Number.isNaN(sizes[1]) ? sizes[1] : 55,
    typeof sizes[2] === 'number' && !Number.isNaN(sizes[2]) ? sizes[2] : 20,
  ];

  const safeSizes: [number, number, number] = [safeLeftSize, safeRightSize, safeConsoleSize];

  const { show: handleShowLeftPanel, hide: handleHideLeftPanel } = usePanelToggle(
    leftPanelRef,
    toggleLeftPanel,
    {
      focusRef: hideExplorerButtonRef,
      liftInitGate: () => {
        isInitialRenderRef.current = false;
      },
      onBeforeShow: () => {
        // Ensure a sensible width when restoring from collapsed/unmounted (do not flip visibility here)
        const nextLeft = safeLeftSize > 1 ? safeLeftSize : 25;
        saveLayout([nextLeft, safeRightSize, safeConsoleSize]);
      },
    }
  );

  const { show: handleShowToolsPanel, hide: handleHideToolsPanel } = usePanelToggle(
    rightPanelRef,
    toggleRightPanel,
    {
      focusRef: hideToolsPanelButtonRef,
      liftInitGate: () => {
        isInitialRenderRef.current = false;
      },
      onBeforeShow: () => {
        const nextRight = safeRightSize > 1 ? safeRightSize : 20;
        saveLayout([safeLeftSize, nextRight, safeConsoleSize]);
      },
    }
  );

  const { show: handleShowConsole, hide: handleConsoleClose } = usePanelToggle(
    consolePanelRef,
    toggleConsole,
    {
      focusRef: hideConsoleButtonRef,
      liftInitGate: () => {
        isInitialRenderRef.current = false;
      },
      onBeforeShow: () => {
        const nextConsole = safeConsoleSize > 1 ? safeConsoleSize : 20;
        saveLayout([safeLeftSize, safeRightSize, nextConsole]);
      },
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
      <div className={cn('flex h-full flex-1 flex-col', className)}>
        <PanelGroup direction="horizontal" onLayout={handleHorizontalLayout}>
          {!showLeftPanel && leftPanelContent && (
            <div className="flex items-center justify-center border-border border-r bg-muted/30 p-2">
              <Button
                aria-label="Show explorer panel"
                className="h-6 w-6"
                data-testid="show-explorer-panel"
                onClick={handleShowLeftPanel}
                size="icon"
                variant="ghost"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          {showLeftPanel && leftPanelContent && (
            <ExplorerPanel
              content={leftPanelContent}
              defaultSize={safeLeftSize}
              hideButtonRef={hideExplorerButtonRef}
              onHide={handleHideLeftPanel}
              panelRef={leftPanelRef}
              {...leftPanelHandlers}
            />
          )}

          <Panel data-panel-id="middle-panel" id="middle-panel" minSize={30} order={2}>
            <PanelGroup direction="vertical" onLayout={handleVerticalLayout}>
              <Panel
                className="bg-background"
                data-panel-id="main-content-panel"
                id="main-content-panel"
                minSize={30}
                order={1}
              >
                <div className="h-full">{children}</div>
              </Panel>

              {!showConsole && consoleContent && (
                <div className="flex items-center justify-center border-border border-t bg-muted/30 py-1">
                  <Button
                    aria-label="Show File Editor"
                    className="h-6"
                    data-testid="show-console-panel"
                    onClick={handleShowConsole}
                    size="sm"
                    variant="ghost"
                  >
                    <Terminal className="h-4 w-4" />
                    <span className="ml-2 text-xs">Show File Editor</span>
                  </Button>
                </div>
              )}
              {showConsole && consoleContent && (
                <ConsolePanel
                  content={consoleContent}
                  defaultSize={safeConsoleSize}
                  hideButtonRef={hideConsoleButtonRef}
                  onHide={handleConsoleClose}
                  panelRef={consolePanelRef}
                  {...consolePanelHandlers}
                />
              )}
            </PanelGroup>
          </Panel>

          {!showRightPanel && rightPanelContent && (
            <div className="flex items-center justify-center border-border border-l bg-muted/30 p-2">
              <Button
                aria-label="Show tools panel"
                className="h-6 w-6"
                data-testid="show-tools-panel"
                onClick={handleShowToolsPanel}
                size="icon"
                variant="ghost"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>
          )}
          {showRightPanel && rightPanelContent && (
            <ToolsPanel
              content={rightPanelContent}
              defaultSize={safeRightSize}
              hideButtonRef={hideToolsPanelButtonRef}
              onHide={handleHideToolsPanel}
              panelRef={rightPanelRef}
              {...rightPanelHandlers}
            />
          )}
        </PanelGroup>
      </div>
    </IdeFileEditorContext.Provider>
  );
});
