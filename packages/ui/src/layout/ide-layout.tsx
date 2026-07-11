import { isDevEnv } from '@brainstrike/utils/env-utils';
import { createLogger } from '@brainstrike/utils/logger';
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

/** Options for {@link FileEditorContextValue.openFileInTab}. */
export interface OpenFileInTabOptions {
  /** 1-based line to scroll into view on first render of the opened tab. */
  line?: number;
  /**
   * Inclusive, 1-based line range to select (and scroll to) on first render of
   * the opened tab — e.g. a search chunk the user opened so the block is
   * highlighted and ready to copy. Wins over {@link OpenFileInTabOptions.line}.
   */
  selection?: { startLine: number; endLine: number };
}

/** Opens (or focuses) the file tab for a compositeKey, optionally line-targeted. */
export type OpenFileInTab = (compositeKey: string, options?: OpenFileInTabOptions) => void;

// Context for sharing file editor functionality between main content and console
interface FileEditorContextValue {
  openFileInTab: OpenFileInTab | undefined;
  registerOpenFileInTab: (fn: OpenFileInTab) => void;
}

const IdeFileEditorContext = createContext<FileEditorContextValue>({
  openFileInTab: undefined,
  registerOpenFileInTab: () => {},
});

export const useIdeFileEditor = () => useContext(IdeFileEditorContext);

const logger = createLogger('IdeLayout');
const LAYOUT_INITIALIZATION_DELAY_MS = 50;
const LAYOUT_INIT_SLOW_THRESHOLD_MS = 100;

/** Validates a panel size from persistence, falling back to the default if invalid. */
function safePanelSize(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && !Number.isNaN(value) && value >= MIN_PANEL_SIZE_THRESHOLD
    ? value
    : fallback;
}

// In react-resizable-panels v4, panels must ALWAYS be rendered (never conditionally mounted).
// Visibility is controlled via the collapsible prop and imperative collapse()/expand() API.
// This is a fundamental architectural requirement - conditional rendering breaks the layout.

// Layout handler configuration
interface LayoutHandlerConfig {
  consoleContent?: React.ReactNode | undefined;
  isInitialRenderRef?: React.RefObject<boolean> | undefined;
  layoutIds: LayoutIds;
  leftPanelContent?: React.ReactNode | undefined;
  rightPanelContent?: React.ReactNode | undefined;
  safeConsoleSize?: number | undefined;
  safeLeftSize?: number | undefined;
  safeRightSize?: number | undefined;
  saveLayout?:
    | ((
        sizes: number[],
        showConsole?: boolean,
        showLeftPanel?: boolean,
        showRightPanel?: boolean
      ) => void)
    | undefined;
  showConsole?: boolean | undefined;
  showLeftPanel?: boolean | undefined;
  showRightPanel?: boolean | undefined;
}

function buildLayoutHandlerConfig(config: LayoutHandlerConfig): LayoutHandlerConfig {
  return { ...config };
}

type SaveLayoutArgs = [
  sizes: number[],
  showConsole: boolean,
  showLeftPanel: boolean,
  showRightPanel: boolean,
];

interface LayoutIds {
  consolePanel: string;
  explorerPanel: string;
  mainContentPanel: string;
  middlePanel: string;
  toolsPanel: string;
}

/** Convert a horizontal layout object into saveLayout arguments. */
function buildHorizontalSaveArgs(
  layout: { [id: string]: number },
  config: LayoutHandlerConfig
): SaveLayoutArgs {
  const rawExplorerSize = layout[config.layoutIds.explorerPanel];
  const rawToolsSize = layout[config.layoutIds.toolsPanel];
  const explorerSize =
    rawExplorerSize !== null && rawExplorerSize !== undefined && rawExplorerSize > 0
      ? rawExplorerSize
      : (config.safeLeftSize ?? 25);
  const toolsSize =
    rawToolsSize !== null && rawToolsSize !== undefined && rawToolsSize > 0
      ? rawToolsSize
      : (config.safeRightSize ?? 20);
  return [
    [explorerSize, toolsSize, config.safeConsoleSize ?? 20],
    !!config.showConsole,
    !!config.showLeftPanel,
    !!config.showRightPanel,
  ];
}

/** Convert a vertical layout object into saveLayout arguments. */
function buildVerticalSaveArgs(
  layout: { [id: string]: number },
  config: LayoutHandlerConfig
): SaveLayoutArgs {
  const rawConsoleSize = layout[config.layoutIds.consolePanel];
  const consoleSize =
    rawConsoleSize !== null && rawConsoleSize !== undefined && rawConsoleSize > 0
      ? rawConsoleSize
      : (config.safeConsoleSize ?? 20);
  return [
    [config.safeLeftSize ?? 25, config.safeRightSize ?? 20, consoleSize],
    !!config.showConsole,
    !!config.showLeftPanel,
    !!config.showRightPanel,
  ];
}

// Custom hook for managing layout change handlers
// Uses RAF coalescing + drag-state deferral to minimize per-frame JS work during resize drag.
// During drag, layouts are stored in a ref and only committed once per animation frame.
// The final layout is flushed on pointerup via the isDraggingRef mechanism.
function useLayoutHandlers(config: LayoutHandlerConfig) {
  const {
    leftPanelContent,
    layoutIds,
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
        consoleContent,
        isInitialRenderRef,
        layoutIds,
        leftPanelContent,
        rightPanelContent,
        safeConsoleSize,
        safeLeftSize,
        safeRightSize,
        saveLayout,
        showConsole,
        showLeftPanel,
        showRightPanel,
      }),
    [
      leftPanelContent,
      layoutIds,
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

  // RAF coalescing: store pending layout, commit at most once per animation frame
  const pendingHorizontalRef = useRef<{ [id: string]: number } | null>(null);
  const pendingVerticalRef = useRef<{ [id: string]: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Drag state tracking: when true, defer saveLayout until drag ends
  const isDraggingRef = useRef(false);
  // Store the latest computed save args so we can flush them on pointerup
  const deferredSaveRef = useRef<SaveLayoutArgs | null>(null);

  /** Dispatch a single set of save args: defer during drag, commit immediately otherwise. */
  const dispatchSave = useCallback(
    (args: SaveLayoutArgs) => {
      if (isDraggingRef.current) {
        deferredSaveRef.current = args;
      } else {
        stableConfig.saveLayout?.(...args);
      }
    },
    [stableConfig]
  );

  const commitLayouts = useCallback(() => {
    rafIdRef.current = null;
    if (stableConfig.isInitialRenderRef?.current || !stableConfig.saveLayout) {
      pendingHorizontalRef.current = null;
      pendingVerticalRef.current = null;
      return;
    }

    if (pendingHorizontalRef.current) {
      const layout = pendingHorizontalRef.current;
      pendingHorizontalRef.current = null;
      dispatchSave(buildHorizontalSaveArgs(layout, stableConfig));
    }

    if (pendingVerticalRef.current) {
      const layout = pendingVerticalRef.current;
      pendingVerticalRef.current = null;
      dispatchSave(buildVerticalSaveArgs(layout, stableConfig));
    }
  }, [stableConfig, dispatchSave]);

  const scheduleCommit = useCallback(() => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(commitLayouts);
    }
  }, [commitLayouts]);

  // Flush deferred layout on drag end
  const flushDeferredSave = useCallback(() => {
    isDraggingRef.current = false;
    if (deferredSaveRef.current && stableConfig.saveLayout) {
      stableConfig.saveLayout(...deferredSaveRef.current);
      deferredSaveRef.current = null;
    }
  }, [stableConfig]);

  // Global pointerup listener to detect drag end
  useEffect(() => {
    const handlePointerUp = () => {
      if (isDraggingRef.current) {
        // Cancel any pending RAF to avoid double-commit
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        // Process any pending layouts into deferredSaveRef before flushing
        if (pendingHorizontalRef.current && stableConfig.saveLayout) {
          deferredSaveRef.current = buildHorizontalSaveArgs(
            pendingHorizontalRef.current,
            stableConfig
          );
        }
        if (pendingVerticalRef.current && stableConfig.saveLayout) {
          deferredSaveRef.current = buildVerticalSaveArgs(pendingVerticalRef.current, stableConfig);
        }
        pendingHorizontalRef.current = null;
        pendingVerticalRef.current = null;
        flushDeferredSave();
      }
    };
    document.addEventListener('pointerup', handlePointerUp);
    return () => {
      document.removeEventListener('pointerup', handlePointerUp);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [flushDeferredSave]);

  const handleSeparatorPointerDown = useCallback(() => {
    isDraggingRef.current = true;
    deferredSaveRef.current = null;
  }, []);

  const handleHorizontalLayout = useCallback(
    (layout: { [id: string]: number }) => {
      if (stableConfig.isInitialRenderRef?.current) {
        return;
      }
      if (!stableConfig.saveLayout) {
        return;
      }
      pendingHorizontalRef.current = layout;
      scheduleCommit();
    },
    [stableConfig, scheduleCommit]
  );

  const handleVerticalLayout = useCallback(
    (layout: { [id: string]: number }) => {
      if (stableConfig.isInitialRenderRef?.current) {
        return;
      }
      if (!stableConfig.saveLayout) {
        return;
      }
      pendingVerticalRef.current = layout;
      scheduleCommit();
    },
    [stableConfig, scheduleCommit]
  );

  return { handleHorizontalLayout, handleSeparatorPointerDown, handleVerticalLayout };
}

// Configuration for initial layout application
interface InitialLayoutConfig {
  consolePanelRef: React.RefObject<PanelImperativeHandle | null>;
  hasAppliedInitialLayout: React.RefObject<boolean>;
  hasConsole: boolean;
  hasExplorer: boolean;
  hasTools: boolean;
  horizontalGroupRef: React.RefObject<GroupImperativeHandle | null>;
  isInitialRenderRef: React.RefObject<boolean>;
  layoutIds: LayoutIds;
  leftPanelRef: React.RefObject<PanelImperativeHandle | null>;
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  safeConsoleSize: number;
  safeLeftSize: number;
  safeRightSize: number;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  verticalGroupRef: React.RefObject<GroupImperativeHandle | null>;
}

// Helper: Apply horizontal layout via Group imperative API
function applyHorizontalLayout(
  groupRef: GroupImperativeHandle,
  layoutIds: LayoutIds,
  hasExplorer: boolean,
  hasTools: boolean,
  showLeftPanel: boolean,
  showRightPanel: boolean,
  safeLeftSize: number,
  safeRightSize: number
): void {
  const layout: { [id: string]: number } = {};
  if (hasExplorer) {
    layout[layoutIds.explorerPanel] = showLeftPanel ? safeLeftSize : 0;
  }
  const leftUsed = hasExplorer && showLeftPanel ? safeLeftSize : 0;
  const rightUsed = hasTools && showRightPanel ? safeRightSize : 0;
  layout[layoutIds.middlePanel] = 100 - leftUsed - rightUsed;
  if (hasTools) {
    layout[layoutIds.toolsPanel] = showRightPanel ? safeRightSize : 0;
  }
  groupRef.setLayout(layout);
}

// Helper: Apply vertical layout via Group imperative API
function applyVerticalLayout(
  groupRef: GroupImperativeHandle,
  layoutIds: LayoutIds,
  hasConsole: boolean,
  showConsole: boolean,
  safeConsoleSize: number
): void {
  const layout: { [id: string]: number } = {};
  const consoleSize = hasConsole && showConsole ? safeConsoleSize : 0;
  layout[layoutIds.mainContentPanel] = 100 - consoleSize;
  if (hasConsole) {
    layout[layoutIds.consolePanel] = consoleSize;
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

function safeResizePanel(
  panelRef: React.RefObject<PanelImperativeHandle | null>,
  size: number | string,
  label: string
): void {
  if (!panelRef.current) {
    return;
  }
  try {
    panelRef.current.resize(size);
  } catch (error) {
    logger.warn(`Failed to resize ${label} panel`, { error });
  }
}

interface InitialLayoutApplicationConfig {
  consolePanelRef: React.RefObject<PanelImperativeHandle | null>;
  hasAppliedInitialLayout: React.RefObject<boolean>;
  hasConsole: boolean;
  hasExplorer: boolean;
  hasTools: boolean;
  horizontalGroupRef: GroupImperativeHandle | null;
  isInitialRenderRef: React.RefObject<boolean>;
  layoutIds: LayoutIds;
  leftPanelRef: React.RefObject<PanelImperativeHandle | null>;
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  safeConsoleSize: number;
  safeLeftSize: number;
  safeRightSize: number;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  verticalGroupRef: GroupImperativeHandle | null;
}

function applyInitialLayout(config: InitialLayoutApplicationConfig): void {
  const startTime = typeof performance === 'undefined' ? null : performance.now();
  try {
    if (config.horizontalGroupRef) {
      applyHorizontalLayout(
        config.horizontalGroupRef,
        config.layoutIds,
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
        config.layoutIds,
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
    config.hasAppliedInitialLayout.current = true;
    config.isInitialRenderRef.current = false;
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
    layoutIds,
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
          console: !!consolePanelRef.current,
          horizontal: !!horizontalGroupRef.current,
          left: !!leftPanelRef.current,
          right: !!rightPanelRef.current,
          vertical: !!verticalGroupRef.current,
        });
      }
      return;
    }

    // Wait for refs and DOM to stabilize
    const timeoutId = setTimeout(() => {
      applyInitialLayout({
        consolePanelRef,
        hasAppliedInitialLayout,
        hasConsole,
        hasExplorer,
        hasTools,
        horizontalGroupRef: horizontalGroupRef.current,
        isInitialRenderRef,
        layoutIds,
        leftPanelRef,
        rightPanelRef,
        safeConsoleSize,
        safeLeftSize,
        safeRightSize,
        showConsole,
        showLeftPanel,
        showRightPanel,
        verticalGroupRef: verticalGroupRef.current,
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
    layoutIds,
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
  const [openFileInTabFn, setOpenFileInTabFn] = React.useState<OpenFileInTab | null>(null);

  const registerOpenFileInTab = useCallback((fn: OpenFileInTab) => {
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
      flush: async () => {},
      load: async () => null,
      save: async () => {},
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
    const { sizes, showConsole, showLeftPanel, showRightPanel } = ctx;

    const saveLayout = (
      newSizes: number[],
      sConsole?: boolean,
      sLeft?: boolean,
      sRight?: boolean
    ) =>
      ctx.setState({
        showConsole: sConsole ?? showConsole,
        showLeftPanel: sLeft ?? showLeftPanel,
        showRightPanel: sRight ?? showRightPanel,
        sizes: newSizes,
      });

    const toggleField = (field: 'showConsole' | 'showLeftPanel' | 'showRightPanel') =>
      ctx.setState({
        showConsole,
        showLeftPanel,
        showRightPanel,
        sizes,
        [field]: !ctx[field],
      });

    return {
      saveLayout,
      showConsole,
      showLeftPanel,
      showRightPanel,
      sizes,
      toggleConsole: () => toggleField('showConsole'),
      toggleLeftPanel: () => toggleField('showLeftPanel'),
      toggleRightPanel: () => toggleField('showRightPanel'),
    } as const;
  }

  return fallback;
}

// Panel toggle handler configuration
interface PanelToggleConfig {
  hideConsoleButtonRef: React.RefObject<HTMLButtonElement | null>;
  hideExplorerButtonRef: React.RefObject<HTMLButtonElement | null>;
  hideToolsPanelButtonRef: React.RefObject<HTMLButtonElement | null>;
  isInitialRenderRef: React.RefObject<boolean>;
  safeConsoleSize: number;
  safeLeftSize: number;
  safeRightSize: number;
  saveLayout: (
    sizes: number[],
    showConsole?: boolean,
    showLeftPanel?: boolean,
    showRightPanel?: boolean
  ) => void;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  toggleConsole: () => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
}

interface PanelChromeConfig {
  hideButtonLabel: string;
  hideButtonTestId: string;
  icon: React.ComponentType<{ className?: string }>;
  showButtonLabel: string;
  showButtonTestId: string;
  title: string;
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
   * - collapsed && isVisible: Panel was dragged to 0% but state still shows visible
   *   -> Update state to hidden
   *
   * - !collapsed && !isVisible: Panel has size > 0% but state shows hidden
   *   -> Update state to visible (with minimum size enforcement)
   *
   * The isInitialRenderRef guard prevents state updates during hydration when
   * the layout is being restored from persistence.
   */
  const createCollapseHandler = useCallback(
    (
      isVisible: boolean,
      buildHiddenArgs: () => Parameters<typeof saveLayout>,
      buildVisibleArgs: () => Parameters<typeof saveLayout>
    ) =>
      (collapsed: boolean) => {
        if (isInitialRenderRef.current) {
          return;
        }
        if (collapsed && isVisible) {
          saveLayout(...buildHiddenArgs());
        } else if (!(collapsed || isVisible)) {
          saveLayout(...buildVisibleArgs());
        }
      },
    [saveLayout, isInitialRenderRef]
  );

  const handleLeftPanelCollapse = useCallback(
    (collapsed: boolean) =>
      createCollapseHandler(
        showLeftPanel,
        () => [[safeLeftSize, safeRightSize, safeConsoleSize], showConsole, false, showRightPanel],
        () => {
          const effectiveLeftSize = safeLeftSize < 10 ? 25 : safeLeftSize;
          return [
            [effectiveLeftSize, safeRightSize, safeConsoleSize],
            showConsole,
            true,
            showRightPanel,
          ];
        }
      )(collapsed),
    [
      createCollapseHandler,
      safeLeftSize,
      safeRightSize,
      safeConsoleSize,
      showConsole,
      showLeftPanel,
      showRightPanel,
    ]
  );

  const handleRightPanelCollapse = useCallback(
    (collapsed: boolean) =>
      createCollapseHandler(
        showRightPanel,
        () => [[safeLeftSize, safeRightSize, safeConsoleSize], showConsole, showLeftPanel, false],
        () => {
          const effectiveRightSize = safeRightSize < 10 ? 20 : safeRightSize;
          return [
            [safeLeftSize, effectiveRightSize, safeConsoleSize],
            showConsole,
            showLeftPanel,
            true,
          ];
        }
      )(collapsed),
    [
      createCollapseHandler,
      safeLeftSize,
      safeRightSize,
      safeConsoleSize,
      showConsole,
      showLeftPanel,
      showRightPanel,
    ]
  );

  const handleConsolePanelCollapse = useCallback(
    (collapsed: boolean) =>
      createCollapseHandler(
        showConsole,
        () => [
          [safeLeftSize, safeRightSize, safeConsoleSize],
          false,
          showLeftPanel,
          showRightPanel,
        ],
        () => {
          const effectiveConsoleSize = safeConsoleSize < 10 ? 20 : safeConsoleSize;
          return [
            [safeLeftSize, safeRightSize, effectiveConsoleSize],
            true,
            showLeftPanel,
            showRightPanel,
          ];
        }
      )(collapsed),
    [
      createCollapseHandler,
      safeLeftSize,
      safeRightSize,
      safeConsoleSize,
      showConsole,
      showLeftPanel,
      showRightPanel,
    ]
  );

  return {
    handleConsolePanelCollapse,
    handleHideConsole,
    handleHideLeftPanel,
    handleHideRightPanel,
    handleLeftPanelCollapse,
    handleRightPanelCollapse,
    handleShowConsole,
    handleShowLeftPanel,
    handleShowRightPanel,
  };
}

export interface IdeLayoutProps {
  children: React.ReactNode;
  className?: string;
  consoleContent?: React.ReactNode;
  leftPanelChrome?: Partial<PanelChromeConfig>;
  leftPanelContent?: React.ReactNode;
  panelConstraints?: Partial<IdeLayoutPanelConstraints>;
  panelIdPrefix?: string;
  rightPanelChrome?: Partial<PanelChromeConfig>;
  rightPanelContent?: React.ReactNode;
}

export interface IdeLayoutPanelConstraints {
  consolePanelMaxSize: number | string;
  consolePanelMinSize: number | string;
  leftPanelMaxSize: number | string;
  leftPanelMinSize: number | string;
  mainContentMinSize: number | string;
  rightPanelMaxSize: number | string;
  rightPanelMinSize: number | string;
}

const DEFAULT_LEFT_PANEL_CHROME: PanelChromeConfig = {
  hideButtonLabel: 'Hide explorer panel',
  hideButtonTestId: 'hide-explorer-panel',
  icon: PanelLeft,
  showButtonLabel: 'Show explorer panel',
  showButtonTestId: 'show-explorer-panel',
  title: 'Explorer',
};

const DEFAULT_RIGHT_PANEL_CHROME: PanelChromeConfig = {
  hideButtonLabel: 'Hide tools panel',
  hideButtonTestId: 'hide-tools-panel',
  icon: PanelRight,
  showButtonLabel: 'Show tools panel',
  showButtonTestId: 'show-tools-panel',
  title: 'Tools',
};

const DEFAULT_PANEL_CONSTRAINTS: IdeLayoutPanelConstraints = {
  consolePanelMaxSize: '80%',
  consolePanelMinSize: '15%',
  leftPanelMaxSize: '50%',
  leftPanelMinSize: '15%',
  mainContentMinSize: '30%',
  rightPanelMaxSize: '60%',
  rightPanelMinSize: '15%',
};

export const IdeLayout = React.memo(function IdeLayout({
  children,
  leftPanelContent,
  leftPanelChrome,
  panelConstraints,
  panelIdPrefix = '',
  rightPanelContent,
  rightPanelChrome,
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

  // Track last collapsed state to skip redundant onResize handler calls during drag
  const leftCollapsedRef = useRef(false);
  const rightCollapsedRef = useRef(false);
  const consoleCollapsedRef = useRef(false);

  const fileEditorContextValue = useFileEditorContext();

  const hideExplorerButtonRef = useRef<HTMLButtonElement>(null);
  const hideToolsPanelButtonRef = useRef<HTMLButtonElement>(null);
  const hideConsoleButtonRef = useRef<HTMLButtonElement>(null);
  const resolvedLeftPanelChrome = useMemo(
    () => ({ ...DEFAULT_LEFT_PANEL_CHROME, ...leftPanelChrome }),
    [leftPanelChrome]
  );
  const resolvedRightPanelChrome = useMemo(
    () => ({ ...DEFAULT_RIGHT_PANEL_CHROME, ...rightPanelChrome }),
    [rightPanelChrome]
  );
  const resolvedPanelConstraints = useMemo(
    () => ({ ...DEFAULT_PANEL_CONSTRAINTS, ...panelConstraints }),
    [panelConstraints]
  );
  const LeftPanelIcon = resolvedLeftPanelChrome.icon;
  const RightPanelIcon = resolvedRightPanelChrome.icon;
  const layoutIds = useMemo<LayoutIds>(() => {
    const prefix = panelIdPrefix ? `${panelIdPrefix}-` : '';
    return {
      consolePanel: `${prefix}console-panel`,
      explorerPanel: `${prefix}explorer-panel`,
      mainContentPanel: `${prefix}main-content-panel`,
      middlePanel: `${prefix}middle-panel`,
      toolsPanel: `${prefix}tools-panel`,
    };
  }, [panelIdPrefix]);

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
  // Enforce minimum thresholds to prevent corrupted tiny values from localStorage
  const safeLeftSize = safePanelSize(sizes[0], DEFAULT_PANEL_SIZES[0]);
  const safeRightSize = safePanelSize(sizes[1], DEFAULT_PANEL_SIZES[1]);
  const safeConsoleSize = safePanelSize(sizes[2], DEFAULT_PANEL_SIZES[2]);

  // Determine if we should render panels (has content)
  const hasExplorer = !!leftPanelContent;
  const hasTools = !!rightPanelContent;
  const hasConsole = !!consoleContent;

  // v4 CRITICAL: Apply initial layout imperatively after mount
  // defaultLayout only works on first render - we need setLayout() for dynamic control
  useInitialLayoutEffect({
    consolePanelRef,
    hasAppliedInitialLayout,
    hasConsole,
    hasExplorer,
    hasTools,
    horizontalGroupRef,
    isInitialRenderRef,
    layoutIds,
    leftPanelRef,
    rightPanelRef,
    safeConsoleSize,
    safeLeftSize,
    safeRightSize,
    showConsole,
    showLeftPanel,
    showRightPanel,
    verticalGroupRef,
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
      if (showConsole) {
        // Keep visual size aligned with persisted percentage when reopening the panel.
        safeTogglePanelVisibility(consolePanelRef, true, 'console');
        safeResizePanel(consolePanelRef, `${safeConsoleSize}%`, 'console');
        return;
      }
      safeTogglePanelVisibility(consolePanelRef, false, 'console');
    }
  }, [showConsole, consoleContent, safeConsoleSize]);

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
    hideConsoleButtonRef,
    hideExplorerButtonRef,
    hideToolsPanelButtonRef,
    isInitialRenderRef,
    safeConsoleSize,
    safeLeftSize,
    safeRightSize,
    saveLayout,
    showConsole,
    showLeftPanel,
    showRightPanel,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
  });

  // Layout handlers
  const layoutConfig: LayoutHandlerConfig = {
    consoleContent,
    isInitialRenderRef,
    layoutIds,
    leftPanelContent,
    rightPanelContent,
    safeConsoleSize,
    safeLeftSize,
    safeRightSize,
    saveLayout,
    showConsole,
    showLeftPanel,
    showRightPanel,
  };

  const { handleHorizontalLayout, handleVerticalLayout, handleSeparatorPointerDown } =
    useLayoutHandlers(layoutConfig);

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
      layout[layoutIds.explorerPanel] = leftSize;
    }
    layout[layoutIds.middlePanel] = middleSize;
    if (hasTools) {
      layout[layoutIds.toolsPanel] = rightSize;
    }

    return layout;
  }, [
    hasExplorer,
    hasTools,
    layoutIds,
    showLeftPanel,
    showRightPanel,
    safeLeftSize,
    safeRightSize,
  ]);

  // v4: Build defaultLayout for the vertical Group (console)
  // All panels must ALWAYS be included
  const verticalLayout = useMemo(() => {
    const layout: { [id: string]: number } = {};

    const consoleSize = hasConsole && showConsole ? safeConsoleSize : 0;
    layout[layoutIds.mainContentPanel] = 100 - consoleSize;
    if (hasConsole) {
      layout[layoutIds.consolePanel] = consoleSize;
    }

    return layout;
  }, [hasConsole, layoutIds, showConsole, safeConsoleSize]);

  return (
    <IdeFileEditorContext.Provider value={fileEditorContextValue}>
      <div className={cn('relative flex h-full flex-1 flex-col', className)}>
        {/* Toggle buttons outside the Group - fixed position overlay */}
        {hasExplorer && !showLeftPanel && (
          <div className="absolute top-1/2 left-0 z-10 -translate-y-1/2">
            <Button
              aria-expanded={showLeftPanel}
              aria-label={resolvedLeftPanelChrome.showButtonLabel}
              className="h-8 w-6 rounded-r-md rounded-l-none border border-border border-l-0 bg-muted/90 shadow-sm"
              data-testid={resolvedLeftPanelChrome.showButtonTestId}
              onClick={handleShowLeftPanel}
              size="icon"
              title={resolvedLeftPanelChrome.showButtonLabel}
              variant="ghost"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        {hasTools && !showRightPanel && (
          <div className="absolute top-1/2 right-0 z-10 -translate-y-1/2">
            <Button
              aria-expanded={showRightPanel}
              aria-label={resolvedRightPanelChrome.showButtonLabel}
              className="h-8 w-6 rounded-r-none rounded-l-md border border-border border-r-0 bg-muted/90 shadow-sm"
              data-testid={resolvedRightPanelChrome.showButtonTestId}
              onClick={handleShowRightPanel}
              size="icon"
              title={resolvedRightPanelChrome.showButtonLabel}
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
                id={layoutIds.explorerPanel}
                maxSize={resolvedPanelConstraints.leftPanelMaxSize}
                minSize={resolvedPanelConstraints.leftPanelMinSize}
                onResize={(panelSize) => {
                  const collapsed = panelSize.asPercentage === 0;
                  if (collapsed !== leftCollapsedRef.current) {
                    leftCollapsedRef.current = collapsed;
                    handleLeftPanelCollapse(collapsed);
                  }
                }}
                panelRef={leftPanelRef}
              >
                <div className="flex h-full flex-col overflow-hidden [contain:layout_paint_style]">
                  <div
                    className="flex h-12 shrink-0 items-center justify-between border-border border-b bg-muted/30 px-2"
                    data-testid="left-panel-header"
                  >
                    <div className="flex items-center gap-2">
                      <LeftPanelIcon className="h-4 w-4" />
                      <span className="font-medium text-sm">{resolvedLeftPanelChrome.title}</span>
                    </div>
                    <Button
                      aria-expanded={showLeftPanel}
                      aria-label={resolvedLeftPanelChrome.hideButtonLabel}
                      className="h-6 w-6"
                      data-testid={resolvedLeftPanelChrome.hideButtonTestId}
                      onClick={handleHideLeftPanel}
                      ref={hideExplorerButtonRef}
                      size="icon"
                      title={resolvedLeftPanelChrome.hideButtonLabel}
                      variant="ghost"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">{leftPanelContent}</div>
                </div>
              </Panel>
              <Separator
                aria-label={`Resize ${resolvedLeftPanelChrome.title} panel`}
                className={cn(
                  'z-10 w-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  showLeftPanel ? 'bg-panel-divider hover:bg-panel-divider/80' : 'bg-transparent'
                )}
                onPointerDown={handleSeparatorPointerDown}
              />
            </>
          )}

          {/* Middle Panel - Main content area with optional console */}
          <Panel id={layoutIds.middlePanel} minSize={resolvedPanelConstraints.mainContentMinSize}>
            <Group
              defaultLayout={verticalLayout}
              groupRef={verticalGroupRef}
              onLayoutChanged={handleVerticalLayout}
              orientation="vertical"
            >
              <Panel
                className="bg-background"
                id={layoutIds.mainContentPanel}
                minSize={resolvedPanelConstraints.mainContentMinSize}
              >
                <div className="flex h-full flex-col [contain:layout_paint_style]">
                  <div className="min-h-0 flex-1">{children}</div>
                  {/* Show console toggle when collapsed - inside main content panel */}
                  {hasConsole && !showConsole && (
                    <div className="flex shrink-0 items-center justify-center border-border border-t bg-muted/30 py-1">
                      <Button
                        aria-label="Show File Editor"
                        className="h-6"
                        data-testid="show-console-panel"
                        onClick={handleShowConsole}
                        size="sm"
                        title="Show File Editor"
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
                  <Separator
                    aria-label="Resize File Editor panel"
                    className={cn(
                      'z-10 h-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      showConsole ? 'bg-panel-divider hover:bg-panel-divider/80' : 'bg-transparent'
                    )}
                    onPointerDown={handleSeparatorPointerDown}
                  />
                  <Panel
                    className="bg-background"
                    collapsedSize="0%"
                    collapsible
                    id={layoutIds.consolePanel}
                    maxSize={resolvedPanelConstraints.consolePanelMaxSize}
                    minSize={resolvedPanelConstraints.consolePanelMinSize}
                    onResize={(panelSize) => {
                      const collapsed = panelSize.asPercentage === 0;
                      if (collapsed !== consoleCollapsedRef.current) {
                        consoleCollapsedRef.current = collapsed;
                        handleConsolePanelCollapse(collapsed);
                      }
                    }}
                    panelRef={consolePanelRef}
                  >
                    <div className="flex h-full flex-col [contain:layout_paint_style]">
                      <div
                        className="flex h-12 shrink-0 items-center justify-between border-border border-b bg-muted/30 px-2"
                        data-testid="console-panel-header"
                      >
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
                          title="Close File Editor"
                          variant="ghost"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-auto">{consoleContent}</div>
                    </div>
                  </Panel>
                </>
              )}
            </Group>
          </Panel>

          {/* Tools Panel - conditionally rendered based on content availability */}
          {hasTools && (
            <>
              <Separator
                aria-label={`Resize ${resolvedRightPanelChrome.title} panel`}
                className={cn(
                  'z-10 w-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  showRightPanel ? 'bg-panel-divider hover:bg-panel-divider/80' : 'bg-transparent'
                )}
                onPointerDown={handleSeparatorPointerDown}
              />
              <Panel
                className="bg-background"
                collapsedSize="0%"
                collapsible
                id={layoutIds.toolsPanel}
                maxSize={resolvedPanelConstraints.rightPanelMaxSize}
                minSize={resolvedPanelConstraints.rightPanelMinSize}
                onResize={(panelSize) => {
                  const collapsed = panelSize.asPercentage === 0;
                  if (collapsed !== rightCollapsedRef.current) {
                    rightCollapsedRef.current = collapsed;
                    handleRightPanelCollapse(collapsed);
                  }
                }}
                panelRef={rightPanelRef}
              >
                <div className="flex h-full flex-col [contain:layout_paint_style]">
                  <div
                    className="flex h-12 shrink-0 items-center justify-between border-border border-b bg-muted/30 px-2"
                    data-testid="right-panel-header"
                  >
                    <div className="flex items-center gap-2">
                      <RightPanelIcon className="h-4 w-4" />
                      <span className="font-medium text-sm">{resolvedRightPanelChrome.title}</span>
                    </div>
                    <Button
                      aria-expanded={showRightPanel}
                      aria-label={resolvedRightPanelChrome.hideButtonLabel}
                      className="h-6 w-6"
                      data-testid={resolvedRightPanelChrome.hideButtonTestId}
                      onClick={handleHideRightPanel}
                      ref={hideToolsPanelButtonRef}
                      size="icon"
                      title={resolvedRightPanelChrome.hideButtonLabel}
                      variant="ghost"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
