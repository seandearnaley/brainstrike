import { createLogger, isDevEnv } from '@brainstrike/utils';
import { ChevronLeft, ChevronRight, PanelLeft, PanelRight, Terminal, X } from 'lucide-react';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
  Group,
  type GroupImperativeHandle,
  Panel,
  type PanelImperativeHandle,
  Separator,
} from 'react-resizable-panels';
import { Button } from '../button';
import type { PanelPersistenceAdapter } from '../hooks/panel-persistence-adapters';
import { usePanelPersistence } from '../hooks/use-panel-persistence';
import { DEFAULT_PANEL_SIZES, MIN_PANEL_SIZE_THRESHOLD } from '../lib/panel-constants';
import { cn } from '../lib/utils';
import { usePanelLayout } from '../providers/panel-layout-provider';

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

const logger = createLogger('IdeLayout');
const LAYOUT_INITIALIZATION_DELAY_MS = 50;
const LAYOUT_INIT_SLOW_THRESHOLD_MS = 100;

// In react-resizable-panels v4, panels must ALWAYS be rendered (never conditionally mounted).
// Visibility is controlled via the collapsible prop and imperative collapse()/expand() API.
// This is a fundamental architectural requirement - conditional rendering breaks the layout.

// Layout handler configuration
interface LayoutHandlerConfig {
  leftPanelContent?: React.ReactNode | undefined;
  rightPanelContent?: React.ReactNode | undefined;
  consoleContent?: React.ReactNode | undefined;
  showLeftPanel?: boolean | undefined;
  showRightPanel?: boolean | undefined;
  showConsole?: boolean | undefined;
  safeLeftSize?: number | undefined;
  safeRightSize?: number | undefined;
  safeConsoleSize?: number | undefined;
  saveLayout?:
    | ((
        sizes: number[],
        showConsole?: boolean,
        showLeftPanel?: boolean,
        showRightPanel?: boolean
      ) => void)
    | undefined;
  isInitialRenderRef?: React.RefObject<boolean> | undefined;
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
  if (config.isInitialRenderRef) {
    cfg.isInitialRenderRef = config.isInitialRenderRef;
  }
  return cfg;
}

// Custom hook for managing layout change handlers
function useLayoutHandlers(config: LayoutHandlerConfig) {
  const {
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
    isInitialRenderRef,
  } = config;

  const stableConfig = useMemo<LayoutHandlerConfig>(
    () =>
      buildLayoutHandlerConfig({
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
        isInitialRenderRef,
      }),
    [
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
      isInitialRenderRef,
    ]
  );

  const handleHorizontalLayout = useCallback(
    (layout: { [id: string]: number }) => {
      if (stableConfig.isInitialRenderRef?.current) {
        return;
      }
      if (!stableConfig.saveLayout) {
        return;
      }

      // Preserve last non-zero size when panel is collapsed (size=0)
      // This ensures reopening a hidden panel restores user's previous width
      const rawExplorerSize = layout['explorer-panel'];
      const rawToolsSize = layout['tools-panel'];
      const explorerSize =
        rawExplorerSize != null && rawExplorerSize > 0
          ? rawExplorerSize
          : (stableConfig.safeLeftSize ?? 25);
      const toolsSize =
        rawToolsSize != null && rawToolsSize > 0
          ? rawToolsSize
          : (stableConfig.safeRightSize ?? 20);

      stableConfig.saveLayout(
        [explorerSize, toolsSize, stableConfig.safeConsoleSize ?? 20],
        !!stableConfig.showConsole,
        !!stableConfig.showLeftPanel,
        !!stableConfig.showRightPanel
      );
    },
    [stableConfig]
  );

  const handleVerticalLayout = useCallback(
    (layout: { [id: string]: number }) => {
      if (stableConfig.isInitialRenderRef?.current) {
        return;
      }
      if (!stableConfig.saveLayout) {
        return;
      }

      // Preserve last non-zero size when panel is collapsed (size=0)
      const rawConsoleSize = layout['console-panel'];
      const consoleSize =
        rawConsoleSize != null && rawConsoleSize > 0
          ? rawConsoleSize
          : (stableConfig.safeConsoleSize ?? 20);
      stableConfig.saveLayout(
        [stableConfig.safeLeftSize ?? 25, stableConfig.safeRightSize ?? 20, consoleSize],
        !!stableConfig.showConsole,
        !!stableConfig.showLeftPanel,
        !!stableConfig.showRightPanel
      );
    },
    [stableConfig]
  );

  return { handleHorizontalLayout, handleVerticalLayout };
}

// Configuration for initial layout application
interface InitialLayoutConfig {
  horizontalGroupRef: React.RefObject<GroupImperativeHandle | null>;
  verticalGroupRef: React.RefObject<GroupImperativeHandle | null>;
  leftPanelRef: React.RefObject<PanelImperativeHandle | null>;
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  consolePanelRef: React.RefObject<PanelImperativeHandle | null>;
  hasAppliedInitialLayout: React.RefObject<boolean>;
  isInitialRenderRef: React.RefObject<boolean>;
  hasExplorer: boolean;
  hasTools: boolean;
  hasConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  showConsole: boolean;
  safeLeftSize: number;
  safeRightSize: number;
  safeConsoleSize: number;
}

// Helper: Apply horizontal layout via Group imperative API
function applyHorizontalLayout(
  groupRef: GroupImperativeHandle,
  hasExplorer: boolean,
  hasTools: boolean,
  showLeftPanel: boolean,
  showRightPanel: boolean,
  safeLeftSize: number,
  safeRightSize: number
): void {
  const layout: { [id: string]: number } = {};
  if (hasExplorer) {
    layout['explorer-panel'] = showLeftPanel ? safeLeftSize : 0;
  }
  const leftUsed = hasExplorer && showLeftPanel ? safeLeftSize : 0;
  const rightUsed = hasTools && showRightPanel ? safeRightSize : 0;
  layout['middle-panel'] = 100 - leftUsed - rightUsed;
  if (hasTools) {
    layout['tools-panel'] = showRightPanel ? safeRightSize : 0;
  }
  groupRef.setLayout(layout);
}

// Helper: Apply vertical layout via Group imperative API
function applyVerticalLayout(
  groupRef: GroupImperativeHandle,
  hasConsole: boolean,
  showConsole: boolean,
  safeConsoleSize: number
): void {
  const layout: { [id: string]: number } = {};
  const consoleSize = hasConsole && showConsole ? safeConsoleSize : 0;
  layout['main-content-panel'] = 100 - consoleSize;
  if (hasConsole) {
    layout['console-panel'] = consoleSize;
  }
  groupRef.setLayout(layout);
}

// Helper: Apply collapsed state via Panel imperative API
function applyCollapsedState(
  leftPanelRef: React.RefObject<PanelImperativeHandle | null>,
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>,
  consolePanelRef: React.RefObject<PanelImperativeHandle | null>,
  hasExplorer: boolean,
  hasTools: boolean,
  hasConsole: boolean,
  showLeftPanel: boolean,
  showRightPanel: boolean,
  showConsole: boolean
): void {
  if (hasExplorer && !showLeftPanel) {
    safeTogglePanelVisibility(leftPanelRef, false, 'left');
  }
  if (hasTools && !showRightPanel) {
    safeTogglePanelVisibility(rightPanelRef, false, 'right');
  }
  if (hasConsole && !showConsole) {
    safeTogglePanelVisibility(consolePanelRef, false, 'console');
  }
}

function safeTogglePanelVisibility(
  panelRef: React.RefObject<PanelImperativeHandle | null>,
  show: boolean,
  label: string
): void {
  if (!panelRef.current) {
    return;
  }
  try {
    if (show) {
      panelRef.current.expand();
    } else {
      panelRef.current.collapse();
    }
  } catch (error) {
    logger.warn(`Failed to toggle ${label} panel visibility`, { error });
  }
}

interface InitialLayoutApplicationConfig {
  horizontalGroupRef: GroupImperativeHandle | null;
  verticalGroupRef: GroupImperativeHandle | null;
  leftPanelRef: React.RefObject<PanelImperativeHandle | null>;
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  consolePanelRef: React.RefObject<PanelImperativeHandle | null>;
  hasAppliedInitialLayout: React.RefObject<boolean>;
  isInitialRenderRef: React.RefObject<boolean>;
  hasExplorer: boolean;
  hasTools: boolean;
  hasConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  showConsole: boolean;
  safeLeftSize: number;
  safeRightSize: number;
  safeConsoleSize: number;
}

function applyInitialLayout(config: InitialLayoutApplicationConfig): void {
  const startTime = typeof performance !== 'undefined' ? performance.now() : null;
  try {
    if (config.horizontalGroupRef) {
      applyHorizontalLayout(
        config.horizontalGroupRef,
        config.hasExplorer,
        config.hasTools,
        config.showLeftPanel,
        config.showRightPanel,
        config.safeLeftSize,
        config.safeRightSize
      );
    }

    if (config.verticalGroupRef) {
      applyVerticalLayout(
        config.verticalGroupRef,
        config.hasConsole,
        config.showConsole,
        config.safeConsoleSize
      );
    }

    applyCollapsedState(
      config.leftPanelRef,
      config.rightPanelRef,
      config.consolePanelRef,
      config.hasExplorer,
      config.hasTools,
      config.hasConsole,
      config.showLeftPanel,
      config.showRightPanel,
      config.showConsole
    );

    config.hasAppliedInitialLayout.current = true;
    config.isInitialRenderRef.current = false;
  } catch (error) {
    logger.warn('Failed to apply initial layout', { error });
  } finally {
    if (isDevEnv() && startTime !== null) {
      const duration = performance.now() - startTime;
      if (duration > LAYOUT_INIT_SLOW_THRESHOLD_MS) {
        logger.warn('Slow layout initialization', { duration });
      }
    }
  }
}

// Custom hook for applying initial layout imperatively (v4 requirement)
function useInitialLayoutEffect(config: InitialLayoutConfig): void {
  const {
    horizontalGroupRef,
    verticalGroupRef,
    leftPanelRef,
    rightPanelRef,
    consolePanelRef,
    hasAppliedInitialLayout,
    isInitialRenderRef,
    hasExplorer,
    hasTools,
    hasConsole,
    showLeftPanel,
    showRightPanel,
    showConsole,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
  } = config;

  const hasLoggedMissingRefs = useRef(false);

  useEffect(() => {
    if (hasAppliedInitialLayout.current) {
      return;
    }

    const refsReady =
      horizontalGroupRef.current !== null &&
      verticalGroupRef.current !== null &&
      (!hasExplorer || leftPanelRef.current !== null) &&
      (!hasTools || rightPanelRef.current !== null) &&
      (!hasConsole || consolePanelRef.current !== null);

    if (!refsReady) {
      if (isDevEnv() && !hasLoggedMissingRefs.current) {
        hasLoggedMissingRefs.current = true;
        logger.warn('Panel refs not ready for layout initialization', {
          horizontal: !!horizontalGroupRef.current,
          vertical: !!verticalGroupRef.current,
          left: !!leftPanelRef.current,
          right: !!rightPanelRef.current,
          console: !!consolePanelRef.current,
        });
      }
      return;
    }

    // Wait for refs and DOM to stabilize
    const timeoutId = setTimeout(() => {
      applyInitialLayout({
        horizontalGroupRef: horizontalGroupRef.current,
        verticalGroupRef: verticalGroupRef.current,
        leftPanelRef,
        rightPanelRef,
        consolePanelRef,
        hasAppliedInitialLayout,
        isInitialRenderRef,
        hasExplorer,
        hasTools,
        hasConsole,
        showLeftPanel,
        showRightPanel,
        showConsole,
        safeLeftSize,
        safeRightSize,
        safeConsoleSize,
      });
    }, LAYOUT_INITIALIZATION_DELAY_MS); // Wait for DOM to stabilize

    return () => clearTimeout(timeoutId);
  }, [
    horizontalGroupRef,
    verticalGroupRef,
    leftPanelRef,
    rightPanelRef,
    consolePanelRef,
    hasAppliedInitialLayout,
    isInitialRenderRef,
    hasExplorer,
    hasTools,
    hasConsole,
    showLeftPanel,
    showRightPanel,
    showConsole,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
  ]);
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

// Resolve panel state from provider if present, otherwise use internal persistence
function useResolvedPanelState(leftPanelContent?: React.ReactNode) {
  const ctx = usePanelLayout();
  if (!ctx && isDevEnv()) {
    throw new Error('Missing PanelLayoutProvider');
  }

  const noopAdapter: PanelPersistenceAdapter = useMemo(
    () => ({
      load: async () => null,
      save: async () => {},
      flush: async () => {},
    }),
    []
  );
  // sizes format: [leftPanelSize, rightPanelSize, consolePanelSize]
  // The middle panel size is calculated dynamically as: 100 - left - right
  const fallback = usePanelPersistence(
    [25, 20, 20],
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

// Panel toggle handler configuration
interface PanelToggleConfig {
  safeLeftSize: number;
  safeRightSize: number;
  safeConsoleSize: number;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  saveLayout: (
    sizes: number[],
    showConsole?: boolean,
    showLeftPanel?: boolean,
    showRightPanel?: boolean
  ) => void;
  toggleConsole: () => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  isInitialRenderRef: React.RefObject<boolean>;
  hideExplorerButtonRef: React.RefObject<HTMLButtonElement | null>;
  hideToolsPanelButtonRef: React.RefObject<HTMLButtonElement | null>;
  hideConsoleButtonRef: React.RefObject<HTMLButtonElement | null>;
}

// Custom hook for panel toggle handlers - extracted to reduce component complexity
function usePanelToggleHandlers(config: PanelToggleConfig) {
  const {
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
    showConsole,
    showLeftPanel,
    showRightPanel,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
    isInitialRenderRef,
    hideExplorerButtonRef,
    hideToolsPanelButtonRef,
    hideConsoleButtonRef,
  } = config;

  const handleShowLeftPanel = useCallback(() => {
    isInitialRenderRef.current = false;
    const effectiveLeftSize = safeLeftSize < 10 ? 25 : safeLeftSize;
    saveLayout(
      [effectiveLeftSize, safeRightSize, safeConsoleSize],
      showConsole,
      true,
      showRightPanel
    );
    toggleLeftPanel();
    requestAnimationFrame(() => {
      hideExplorerButtonRef.current?.focus();
    });
  }, [
    toggleLeftPanel,
    saveLayout,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
    showConsole,
    showRightPanel,
    isInitialRenderRef,
    hideExplorerButtonRef,
  ]);

  const handleHideLeftPanel = useCallback(() => {
    isInitialRenderRef.current = false;
    toggleLeftPanel();
  }, [toggleLeftPanel, isInitialRenderRef]);

  const handleShowRightPanel = useCallback(() => {
    isInitialRenderRef.current = false;
    const effectiveRightSize = safeRightSize < 10 ? 20 : safeRightSize;
    saveLayout(
      [safeLeftSize, effectiveRightSize, safeConsoleSize],
      showConsole,
      showLeftPanel,
      true
    );
    toggleRightPanel();
    requestAnimationFrame(() => {
      hideToolsPanelButtonRef.current?.focus();
    });
  }, [
    toggleRightPanel,
    saveLayout,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
    showConsole,
    showLeftPanel,
    isInitialRenderRef,
    hideToolsPanelButtonRef,
  ]);

  const handleHideRightPanel = useCallback(() => {
    isInitialRenderRef.current = false;
    toggleRightPanel();
  }, [toggleRightPanel, isInitialRenderRef]);

  const handleShowConsole = useCallback(() => {
    isInitialRenderRef.current = false;
    const effectiveConsoleSize = safeConsoleSize < 10 ? 20 : safeConsoleSize;
    saveLayout(
      [safeLeftSize, safeRightSize, effectiveConsoleSize],
      true,
      showLeftPanel,
      showRightPanel
    );
    toggleConsole();
    requestAnimationFrame(() => {
      hideConsoleButtonRef.current?.focus();
    });
  }, [
    toggleConsole,
    saveLayout,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
    showLeftPanel,
    showRightPanel,
    isInitialRenderRef,
    hideConsoleButtonRef,
  ]);

  const handleHideConsole = useCallback(() => {
    isInitialRenderRef.current = false;
    toggleConsole();
  }, [toggleConsole, isInitialRenderRef]);

  /**
   * Handle panel collapse/expand triggered by drag (onResize callback from react-resizable-panels).
   *
   * This syncs React state with the panel's collapsed/expanded status when users drag
   * panels past their minimum size. The conditional logic prevents redundant state updates:
   *
   * - collapsed && showLeftPanel: Panel was dragged to 0% but state still shows visible
   *   → Update state to hidden (collapsed = true)
   *
   * - !(collapsed || showLeftPanel) which is (!collapsed && !showLeftPanel):
   *   Panel has size > 0% but state shows hidden → Update state to visible
   *   Uses effectiveLeftSize to ensure minimum 25% if previous size was too small
   *
   * The isInitialRenderRef guard prevents state updates during hydration when
   * the layout is being restored from persistence.
   */
  const handleLeftPanelCollapse = useCallback(
    (collapsed: boolean) => {
      if (isInitialRenderRef.current) {
        return;
      }
      // Case 1: Panel dragged closed but state says visible → hide it
      if (collapsed && showLeftPanel) {
        saveLayout(
          [safeLeftSize, safeRightSize, safeConsoleSize],
          showConsole,
          false,
          showRightPanel
        );
      }
      // Case 2: Panel dragged open but state says hidden → show it
      // (!collapsed && !showLeftPanel) - panel has size but state shows hidden
      else if (!(collapsed || showLeftPanel)) {
        const effectiveLeftSize = safeLeftSize < 10 ? 25 : safeLeftSize;
        saveLayout(
          [effectiveLeftSize, safeRightSize, safeConsoleSize],
          showConsole,
          true,
          showRightPanel
        );
      }
    },
    [
      saveLayout,
      safeLeftSize,
      safeRightSize,
      safeConsoleSize,
      showConsole,
      showLeftPanel,
      showRightPanel,
      isInitialRenderRef,
    ]
  );

  const handleRightPanelCollapse = useCallback(
    (collapsed: boolean) => {
      if (isInitialRenderRef.current) {
        return;
      }
      // Only update if state doesn't match the collapsed status
      if (collapsed && showRightPanel) {
        saveLayout(
          [safeLeftSize, safeRightSize, safeConsoleSize],
          showConsole,
          showLeftPanel,
          false
        );
      } else if (!(collapsed || showRightPanel)) {
        const effectiveRightSize = safeRightSize < 10 ? 20 : safeRightSize;
        saveLayout(
          [safeLeftSize, effectiveRightSize, safeConsoleSize],
          showConsole,
          showLeftPanel,
          true
        );
      }
    },
    [
      saveLayout,
      safeLeftSize,
      safeRightSize,
      safeConsoleSize,
      showConsole,
      showLeftPanel,
      showRightPanel,
      isInitialRenderRef,
    ]
  );

  const handleConsolePanelCollapse = useCallback(
    (collapsed: boolean) => {
      if (isInitialRenderRef.current) {
        return;
      }
      // Only update if state doesn't match the collapsed status
      if (collapsed && showConsole) {
        saveLayout(
          [safeLeftSize, safeRightSize, safeConsoleSize],
          false,
          showLeftPanel,
          showRightPanel
        );
      } else if (!(collapsed || showConsole)) {
        const effectiveConsoleSize = safeConsoleSize < 10 ? 20 : safeConsoleSize;
        saveLayout(
          [safeLeftSize, safeRightSize, effectiveConsoleSize],
          true,
          showLeftPanel,
          showRightPanel
        );
      }
    },
    [
      saveLayout,
      safeLeftSize,
      safeRightSize,
      safeConsoleSize,
      showConsole,
      showLeftPanel,
      showRightPanel,
      isInitialRenderRef,
    ]
  );

  return {
    handleShowLeftPanel,
    handleHideLeftPanel,
    handleShowRightPanel,
    handleHideRightPanel,
    handleShowConsole,
    handleHideConsole,
    handleLeftPanelCollapse,
    handleRightPanelCollapse,
    handleConsolePanelCollapse,
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
  // Panel refs for imperative collapse/expand control
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const consolePanelRef = useRef<PanelImperativeHandle>(null);

  // Group refs for imperative layout control (v4 API)
  const horizontalGroupRef = useRef<GroupImperativeHandle>(null);
  const verticalGroupRef = useRef<GroupImperativeHandle>(null);

  const isInitialRenderRef = useRef(true);
  const hasAppliedInitialLayout = useRef(false);

  const fileEditorContextValue = useFileEditorContext();

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

  // sizes format: [leftPanelSize, rightPanelSize, consolePanelSize]
  // The middle panel size is calculated dynamically as: 100 - left - right
  // IMPORTANT: Enforce minimum thresholds to prevent corrupted tiny values from localStorage
  const [safeLeftSize, safeRightSize, safeConsoleSize] = [
    typeof sizes[0] === 'number' && !Number.isNaN(sizes[0]) && sizes[0] >= MIN_PANEL_SIZE_THRESHOLD
      ? sizes[0]
      : DEFAULT_PANEL_SIZES[0],
    typeof sizes[1] === 'number' && !Number.isNaN(sizes[1]) && sizes[1] >= MIN_PANEL_SIZE_THRESHOLD
      ? sizes[1]
      : DEFAULT_PANEL_SIZES[1],
    typeof sizes[2] === 'number' && !Number.isNaN(sizes[2]) && sizes[2] >= MIN_PANEL_SIZE_THRESHOLD
      ? sizes[2]
      : DEFAULT_PANEL_SIZES[2],
  ];

  // Determine if we should render panels (has content)
  const hasExplorer = !!leftPanelContent;
  const hasTools = !!rightPanelContent;
  const hasConsole = !!consoleContent;

  // v4 CRITICAL: Apply initial layout imperatively after mount
  // defaultLayout only works on first render - we need setLayout() for dynamic control
  useInitialLayoutEffect({
    horizontalGroupRef,
    verticalGroupRef,
    leftPanelRef,
    rightPanelRef,
    consolePanelRef,
    hasAppliedInitialLayout,
    isInitialRenderRef,
    hasExplorer,
    hasTools,
    hasConsole,
    showLeftPanel,
    showRightPanel,
    showConsole,
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
  });

  // Sync panel visibility with imperative API (for user interactions after mount)
  // In v4, panels are ALWAYS rendered; we use collapse()/expand() to control visibility
  useEffect(() => {
    if (!hasAppliedInitialLayout.current) {
      return;
    }

    if (leftPanelContent && leftPanelRef.current) {
      safeTogglePanelVisibility(leftPanelRef, showLeftPanel, 'left');
    }
  }, [showLeftPanel, leftPanelContent]);

  useEffect(() => {
    if (!hasAppliedInitialLayout.current) {
      return;
    }

    if (rightPanelContent && rightPanelRef.current) {
      safeTogglePanelVisibility(rightPanelRef, showRightPanel, 'right');
    }
  }, [showRightPanel, rightPanelContent]);

  useEffect(() => {
    if (!hasAppliedInitialLayout.current) {
      return;
    }

    if (consoleContent && consolePanelRef.current) {
      safeTogglePanelVisibility(consolePanelRef, showConsole, 'console');
    }
  }, [showConsole, consoleContent]);

  // Toggle handlers - extracted to custom hook to reduce component complexity
  const {
    handleShowLeftPanel,
    handleHideLeftPanel,
    handleShowRightPanel,
    handleHideRightPanel,
    handleShowConsole,
    handleHideConsole,
    handleLeftPanelCollapse,
    handleRightPanelCollapse,
    handleConsolePanelCollapse,
  } = usePanelToggleHandlers({
    safeLeftSize,
    safeRightSize,
    safeConsoleSize,
    showConsole,
    showLeftPanel,
    showRightPanel,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
    isInitialRenderRef,
    hideExplorerButtonRef,
    hideToolsPanelButtonRef,
    hideConsoleButtonRef,
  });

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
    isInitialRenderRef,
  };

  const { handleHorizontalLayout, handleVerticalLayout } = useLayoutHandlers(layoutConfig);

  // v4: Build defaultLayout object for the horizontal Group
  // IMPORTANT: All panels must ALWAYS be included in the layout
  // Collapsed panels should have size 0 (matching their collapsedSize prop)
  const horizontalLayout = useMemo(() => {
    const layout: { [id: string]: number } = {};

    // Calculate effective sizes based on visibility
    const leftSize = hasExplorer && showLeftPanel ? safeLeftSize : 0;
    const rightSize = hasTools && showRightPanel ? safeRightSize : 0;
    const middleSize = 100 - leftSize - rightSize;

    // Always include all panels that exist
    if (hasExplorer) {
      layout['explorer-panel'] = leftSize;
    }
    layout['middle-panel'] = middleSize;
    if (hasTools) {
      layout['tools-panel'] = rightSize;
    }

    return layout;
  }, [hasExplorer, hasTools, showLeftPanel, showRightPanel, safeLeftSize, safeRightSize]);

  // v4: Build defaultLayout for the vertical Group (console)
  // All panels must ALWAYS be included
  const verticalLayout = useMemo(() => {
    const layout: { [id: string]: number } = {};

    const consoleSize = hasConsole && showConsole ? safeConsoleSize : 0;
    layout['main-content-panel'] = 100 - consoleSize;
    if (hasConsole) {
      layout['console-panel'] = consoleSize;
    }

    return layout;
  }, [hasConsole, showConsole, safeConsoleSize]);

  return (
    <IdeFileEditorContext.Provider value={fileEditorContextValue}>
      <div className={cn('relative flex h-full flex-1 flex-col', className)}>
        {/* Toggle buttons outside the Group - fixed position overlay */}
        {hasExplorer && !showLeftPanel && (
          <div className="absolute top-1/2 left-0 z-10 -translate-y-1/2">
            <Button
              aria-label="Show explorer panel"
              className="h-8 w-6 rounded-r-md rounded-l-none border border-border border-l-0 bg-muted/90 shadow-sm"
              data-testid="show-explorer-panel"
              onClick={handleShowLeftPanel}
              size="icon"
              variant="ghost"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        {hasTools && !showRightPanel && (
          <div className="absolute top-1/2 right-0 z-10 -translate-y-1/2">
            <Button
              aria-label="Show tools panel"
              className="h-8 w-6 rounded-r-none rounded-l-md border border-border border-r-0 bg-muted/90 shadow-sm"
              data-testid="show-tools-panel"
              onClick={handleShowRightPanel}
              size="icon"
              variant="ghost"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        )}

        <Group
          defaultLayout={horizontalLayout}
          groupRef={horizontalGroupRef}
          onLayoutChanged={handleHorizontalLayout}
          orientation="horizontal"
        >
          {/* Explorer Panel - conditionally rendered based on content availability */}
          {hasExplorer && (
            <>
              <Panel
                className="overflow-hidden bg-background"
                collapsedSize="0%"
                collapsible
                id="explorer-panel"
                maxSize="50%"
                minSize="15%"
                onResize={(panelSize) => handleLeftPanelCollapse(panelSize.asPercentage === 0)}
                panelRef={leftPanelRef}
              >
                <div className="h-full overflow-hidden">
                  <div className="flex items-center justify-between border-border border-b bg-muted/30 px-2 py-2">
                    <div className="flex items-center gap-2">
                      <PanelLeft className="h-4 w-4" />
                      <span className="font-medium text-sm">Explorer</span>
                    </div>
                    <Button
                      aria-label="Hide explorer panel"
                      className="h-6 w-6"
                      data-testid="hide-explorer-panel"
                      onClick={handleHideLeftPanel}
                      ref={hideExplorerButtonRef}
                      size="icon"
                      variant="ghost"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="h-[calc(100%-2.5rem)] overflow-hidden contain-content">
                    {leftPanelContent}
                  </div>
                </div>
              </Panel>
              <Separator className="z-10 w-1 bg-border transition-colors hover:bg-border/80" />
            </>
          )}

          {/* Middle Panel - Main content area with optional console */}
          <Panel id="middle-panel" minSize="30%">
            <Group
              defaultLayout={verticalLayout}
              groupRef={verticalGroupRef}
              onLayoutChanged={handleVerticalLayout}
              orientation="vertical"
            >
              <Panel className="bg-background" id="main-content-panel" minSize="30%">
                <div className="flex h-full flex-col">
                  <div className="min-h-0 flex-1 contain-content">{children}</div>
                  {/* Show console toggle when collapsed - inside main content panel */}
                  {hasConsole && !showConsole && (
                    <div className="flex shrink-0 items-center justify-center border-border border-t bg-muted/30 py-1">
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
                </div>
              </Panel>

              {/* Console Panel - conditionally rendered based on content availability */}
              {hasConsole && (
                <>
                  <Separator className="z-10 h-1 bg-border transition-colors hover:bg-border/80" />
                  <Panel
                    className="bg-background"
                    collapsedSize="0%"
                    collapsible
                    id="console-panel"
                    maxSize="80%"
                    minSize="15%"
                    onResize={(panelSize) =>
                      handleConsolePanelCollapse(panelSize.asPercentage === 0)
                    }
                    panelRef={consolePanelRef}
                  >
                    <div className="h-full border-border border-t">
                      <div className="flex items-center justify-between border-border border-b bg-muted/30 p-2">
                        <div className="flex items-center gap-2">
                          <Terminal className="h-4 w-4" />
                          <span className="font-medium text-sm">File Editor</span>
                        </div>
                        <Button
                          aria-label="Close File Editor"
                          className="h-6 w-6"
                          data-testid="hide-console-panel"
                          onClick={handleHideConsole}
                          ref={hideConsoleButtonRef}
                          size="icon"
                          variant="ghost"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="h-[calc(100%-2.5rem)] overflow-auto contain-content">
                        {consoleContent}
                      </div>
                    </div>
                  </Panel>
                </>
              )}
            </Group>
          </Panel>

          {/* Tools Panel - conditionally rendered based on content availability */}
          {hasTools && (
            <>
              <Separator className="z-10 w-1 bg-border transition-colors hover:bg-border/80" />
              <Panel
                className="bg-background"
                collapsedSize="0%"
                collapsible
                id="tools-panel"
                maxSize="60%"
                minSize="15%"
                onResize={(panelSize) => handleRightPanelCollapse(panelSize.asPercentage === 0)}
                panelRef={rightPanelRef}
              >
                <div className="h-full border-border border-l">
                  <div className="flex items-center justify-between border-border border-b bg-muted/30 p-2">
                    <div className="flex items-center gap-2">
                      <PanelRight className="h-4 w-4" />
                      <span className="font-medium text-sm">Tools</span>
                    </div>
                    <Button
                      aria-label="Hide tools panel"
                      className="h-6 w-6"
                      data-testid="hide-tools-panel"
                      onClick={handleHideRightPanel}
                      ref={hideToolsPanelButtonRef}
                      size="icon"
                      variant="ghost"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex h-[calc(100%-2.5rem)] flex-col overflow-hidden contain-content">
                    {rightPanelContent}
                  </div>
                </div>
              </Panel>
            </>
          )}
        </Group>
      </div>
    </IdeFileEditorContext.Provider>
  );
});
