import { ArtifactsPage } from '@brainstrike/app-shell/artifacts/artifacts-page';
import { isBrowserBridgeAvailable } from '@brainstrike/app-shell/browser-pane/availability';
import { BrowserPaneContent } from '@brainstrike/app-shell/browser-pane/browser-pane-content';
import { McpContentCapabilityProvider } from '@brainstrike/app-shell/mcp-content-capability';
import { McpStatusCapabilityProvider } from '@brainstrike/app-shell/mcp-status-capability';
import { McpToolsCapabilityProvider } from '@brainstrike/app-shell/mcp-tools-capability';
import { navigationItems } from '@brainstrike/app-shell/navigation';
import {
  type RootLayoutContentProps,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell/root-layout-content';
import type { NavigationItem } from '@brainstrike/app-shell/types';
import { useDocumentTitle } from '@brainstrike/app-shell/use-document-title';
import { WorkspaceGitServicesProvider } from '@brainstrike/app-shell/workspace-git-services';
import { WorkspaceTerminalServicesProvider } from '@brainstrike/app-shell/workspace-terminal-services';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import { McpTaskBridgeProvider } from '@brainstrike/assistant-ui/mcp-task-bridge-context';
import { ToolResultRendererProvider } from '@brainstrike/assistant-ui/tool-result-renderer-context';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui/indexing';
import { createLogger } from '@brainstrike/logging';
import { McpAppsEnablementProvider, mcpAppToolResultRenderer } from '@brainstrike/mcp-app-host-ui';
import { McpElicitationCapabilityProvider } from '@brainstrike/settings-ui/settings/tools/mcp-elicitation-capability';
import { Globe, Shapes } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef } from 'react';
import { indexSearchContract } from '../../ipc-domains/index-search.contract';
import { DESKTOP_DOCUMENT_META } from '../desktop-document-meta';
import { DesktopHostThreadProvider } from '../desktop-host-thread-provider';
import { createDesktopStateHealth } from '../desktop-state-health';
import { resolveDesktopWorkspaceGitServices } from '../host-git-workspace';
import {
  resolveDesktopMcpContent,
  resolveDesktopMcpElicitationBridge,
  resolveDesktopMcpStatusCapability,
  resolveDesktopMcpTaskBridge,
  resolveDesktopMcpToolsCapability,
} from '../host-mcp-settings';
import { resolveDesktopWorkspaceTerminalServices } from '../host-terminals';
import { createIpcCapability } from '../ipc-capability';
import { useMcpAppsEnablement } from '../use-mcp-apps-enablement';
import { ChangesPageContent } from './changes-page-content';
import { LogsPageContent } from './logs-page-content';
import { NativeSearchProvider } from './native-search-provider';
import SettingsPageContent from './settings/page-content';
import TerminalPageContent from './terminal-page-content';
import { ThreadContextPageContent } from './thread-context-page-content';
import { WorktreeMapPageContent } from './worktree-map-page-content';

const BROWSER_NAVIGATION_ITEM: NavigationItem = { icon: Globe, name: 'Browser', path: '/browser' };
const ARTIFACTS_NAVIGATION_ITEM: NavigationItem = {
  icon: Shapes,
  name: 'Artifacts',
  path: '/artifacts',
};
/** The trusted Canvas shell every canvas tab and artifact preview frames. */
const CANVAS_SHELL_SRC = 'brainstrike-canvas://shell/';

const logger = createLogger('DesktopRootLayoutContent');
const RENDERER_HEAP_DIAGNOSTIC_INTERVAL_MS = 15_000;
const RENDERER_HEAP_DIAGNOSTIC_DELTA_BYTES = 128 * 1024 * 1024;
const RENDERER_FRAME_DIAGNOSTIC_INTERVAL_MS = 15_000;
const RENDERER_FRAME_DIAGNOSTIC_SAMPLE_WINDOW_MS = 1000;
const RENDERER_FRAME_STALL_WARN_THRESHOLD_MS = 500;

interface RendererMemoryPerformance extends Performance {
  memory?: {
    jsHeapSizeLimit: number;
    totalJSHeapSize: number;
    usedJSHeapSize: number;
  };
}

/**
 * Wrapper component that provides TokenCacheProvider.
 * The token worker must be ready eagerly so background indexing starts immediately.
 */
function TokenCacheWrapper({ children }: { children: ReactNode }) {
  return <TokenCacheProvider>{children}</TokenCacheProvider>;
}

/** Stable identity: the provider value must not change between renders. */
const MCP_APP_TOOL_RESULT_RENDERERS = Object.freeze([mcpAppToolResultRenderer]);

/** Desktop shell; the host owns persistence. */
export default function RootLayoutContent() {
  // The one writer of the window title, keyed on the route on screen.
  useDocumentTitle(DESKTOP_DOCUMENT_META);
  const nativeSearch = useMemo(
    () =>
      window.indexSearch ? createIpcCapability(window.indexSearch, indexSearchContract) : null,
    []
  );
  const activeToolsTabRef = useRef('host-owned');

  // The agent host owns the git cluster (ADR-0029): Changes, the branch chip
  // and worktrees. Resolved once; each surface below is offered only when its
  // bridge is present (no isElectron check).
  const workspaceGit = useMemo(() => resolveDesktopWorkspaceGitServices(), []);
  const changesAvailable = workspaceGit.changes !== null;
  // ...and the terminal cluster: pty terminals and the command-session
  // inventory. The Terminal tab is offered only when its bridge is present.
  const workspaceTerminals = useMemo(() => resolveDesktopWorkspaceTerminalServices(), []);
  const terminalAvailable = workspaceTerminals.terminal !== null;
  const worktreesAvailable = workspaceGit.worktrees !== null;
  // Capability gate: only surface the Browser tab when the desktop
  // `window.browser` bridge is present (no isElectron check). Resolved once.
  const browserAvailable = useMemo(() => isBrowserBridgeAvailable(), []);
  // Capability port (BST-1566): live MCP task status for the thread's task
  // cards comes from the agent host (BST-1930 c5c); `null` keeps the cards on
  // their persisted snapshot with a visible note. Resolved once.
  const mcpTaskBridge = useMemo(() => resolveDesktopMcpTaskBridge(), []);
  // The MCP input presenters answer server input and cancel its task on the host.
  const mcpElicitationCapability = useMemo(
    () => ({ elicitation: resolveDesktopMcpElicitationBridge(), tasks: mcpTaskBridge }),
    [mcpTaskBridge]
  );
  // The agent host owns the MCP tools and their preferences the composer menu toggles.
  const mcpToolsCapability = useMemo(() => resolveDesktopMcpToolsCapability(), []);
  // ...and the server status the prompt affordances and MCP Apps follow.
  const mcpStatusCapability = useMemo(() => resolveDesktopMcpStatusCapability(), []);
  // ...and the prompt content those affordances read.
  const mcpContentCapability = useMemo(() => resolveDesktopMcpContent(), []);
  const mcpAppsEnabled = useMcpAppsEnablement(mcpStatusCapability);
  const navigationConfig = useMemo<NavigationItem[]>(() => {
    const items = [...navigationItems, ARTIFACTS_NAVIGATION_ITEM];
    if (browserAvailable) {
      items.push(BROWSER_NAVIGATION_ITEM);
    }
    return items;
  }, [browserAvailable]);
  // BST-1880: the damaged-store notice's health read and recovery actions.
  const stateHealth = useMemo(() => createDesktopStateHealth(), []);
  const sharedProps: RootLayoutContentProps = {
    // Canvases (BST-1173) need only the agent host and the brainstrike-canvas:
    // shell protocol, both unconditionally present on desktop: no bridge gate.
    artifactsPageContent: <ArtifactsPage shellSrc={CANVAS_SHELL_SRC} />,
    canvasShellSrc: CANVAS_SHELL_SRC,
    deleteRootData: (rootId) => {
      const bridge = window.electronAPI;
      if (!(bridge && 'fileSystem' in bridge)) {
        throw new Error('Desktop root data deletion bridge is unavailable.');
      }
      return callBoundary(() => bridge.fileSystem.deleteRootData(rootId));
    },
    // Every desktop window has its own log buffer and Electron main's (BST-1791).
    logsPageContent: <LogsPageContent />,
    nativeIndexSearch: nativeSearch,
    navigationItems: navigationConfig,
    settingsPageContent: <SettingsPageContent />,
    stateHealth,
    // Every desktop thread is a committed host conversation, so the context map
    // always has a fold; without the index bridge it draws files by line bands.
    threadContextPageContent: <ThreadContextPageContent chunkBounds={nativeSearch} />,
    ...(browserAvailable ? { browserPageContent: <BrowserPaneContent /> } : {}),
    ...(changesAvailable ? { changesPageContent: <ChangesPageContent /> } : {}),
    ...(terminalAvailable ? { terminalPageContent: <TerminalPageContent /> } : {}),
    ...(worktreesAvailable ? { worktreeMapPageContent: <WorktreeMapPageContent /> } : {}),
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  useEffect(() => {
    const performanceWithMemory = globalThis.performance as RendererMemoryPerformance | undefined;
    if (!performanceWithMemory?.memory) {
      return;
    }

    let previousUsedHeapSize = performanceWithMemory.memory.usedJSHeapSize;
    const intervalId = window.setInterval(() => {
      const currentMemory = performanceWithMemory.memory;
      if (!currentMemory) {
        return;
      }

      const usedHeapDelta = currentMemory.usedJSHeapSize - previousUsedHeapSize;
      if (Math.abs(usedHeapDelta) < RENDERER_HEAP_DIAGNOSTIC_DELTA_BYTES) {
        return;
      }
      previousUsedHeapSize = currentMemory.usedJSHeapSize;

      logger.info('Desktop visible renderer heap changed materially', {
        activeToolsTab: activeToolsTabRef.current,
        deltaBytes: usedHeapDelta,
        jsHeapSizeLimitBytes: currentMemory.jsHeapSizeLimit,
        totalJSHeapBytes: currentMemory.totalJSHeapSize,
        usedJSHeapBytes: currentMemory.usedJSHeapSize,
      });
    }, RENDERER_HEAP_DIAGNOSTIC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (typeof window.requestAnimationFrame !== 'function') {
      return;
    }

    const performanceWithMemory = globalThis.performance as RendererMemoryPerformance | undefined;
    let animationFrameId: number | null = null;
    let sampleWindowStartedAt: number | null = null;
    let previousFrameTime: number | null = null;
    let maxFrameGapMs = 0;
    let frameCount = 0;
    let stalledFrameCount = 0;
    // Startup grace: skip warns until the renderer has had at least one
    // clean 15s window. App boot inherently includes expensive work
    // (FileTreeWorker loading 253 directories, DB demo hydration, MCP
    // tool registration, React mount) which routinely exceeds the 500ms
    // frame threshold. The diagnostic exists to catch REGRESSIONS during
    // normal use — those only surface after the app has settled. Once we
    // observe a clean window, switch into "armed" mode and warn on any
    // future stall.
    let warnsArmed = false;

    const resetFrameWindow = () => {
      maxFrameGapMs = 0;
      frameCount = 0;
      stalledFrameCount = 0;
    };

    const sampleFrame: FrameRequestCallback = (timestamp) => {
      animationFrameId = null;
      if (document.visibilityState !== 'visible') {
        previousFrameTime = null;
        resetFrameWindow();
        return;
      }

      // Explicit guard (not `??=`): React Compiler rejects logical-assignment
      // operators.
      if (sampleWindowStartedAt === null) {
        sampleWindowStartedAt = timestamp;
      }

      if (previousFrameTime !== null) {
        const frameGapMs = timestamp - previousFrameTime;
        maxFrameGapMs = Math.max(maxFrameGapMs, frameGapMs);
        if (frameGapMs >= RENDERER_FRAME_STALL_WARN_THRESHOLD_MS) {
          stalledFrameCount += 1;
        }
      }
      previousFrameTime = timestamp;
      frameCount += 1;

      if (timestamp - sampleWindowStartedAt >= RENDERER_FRAME_DIAGNOSTIC_SAMPLE_WINDOW_MS) {
        return;
      }
      animationFrameId = window.requestAnimationFrame(sampleFrame);
    };

    const startSampling = () => {
      if (document.visibilityState !== 'visible' || animationFrameId !== null) {
        return;
      }
      previousFrameTime = null;
      sampleWindowStartedAt = null;
      animationFrameId = window.requestAnimationFrame(sampleFrame);
    };

    startSampling();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible' && animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      previousFrameTime = null;
      sampleWindowStartedAt = null;
      resetFrameWindow();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        previousFrameTime = null;
        sampleWindowStartedAt = null;
        resetFrameWindow();
        return;
      }

      if (maxFrameGapMs < RENDERER_FRAME_STALL_WARN_THRESHOLD_MS) {
        // First clean window — the app has settled. From here on, real
        // stalls indicate something changed mid-session and are worth a
        // warn.
        if (!warnsArmed) {
          warnsArmed = true;
          logger.debug('Desktop visible renderer frame diagnostic armed');
        }
        resetFrameWindow();
        // Metrics describe the preceding one-second sample, not the full
        // reporting interval. Stop rAF work between reports to keep idle
        // renderers from requesting continuous BeginFrames.
        startSampling();
        return;
      }

      if (!warnsArmed) {
        // Still in startup; expected to be busy. Log at debug so devs
        // who want the data can find it, but don't surface as a warn.
        logger.debug('Desktop visible renderer frame gap during startup (expected)', {
          maxFrameGapMs: Math.round(maxFrameGapMs),
          stalledFrameCount,
        });
        resetFrameWindow();
        startSampling();
        return;
      }

      const currentMemory = performanceWithMemory?.memory;
      const payload = {
        activeToolsTab: activeToolsTabRef.current,
        frameCount,
        jsHeapSizeLimitBytes: currentMemory?.jsHeapSizeLimit ?? null,
        maxFrameGapMs: Math.round(maxFrameGapMs),
        stalledFrameCount,
        totalJSHeapBytes: currentMemory?.totalJSHeapSize ?? null,
        usedJSHeapBytes: currentMemory?.usedJSHeapSize ?? null,
      };

      logger.warn('Desktop visible renderer frame health degraded', payload);
      resetFrameWindow();
      startSampling();
    }, RENDERER_FRAME_DIAGNOSTIC_INTERVAL_MS);

    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, []);

  const content = (
    <TokenCacheWrapper>
      <WorkspaceGitServicesProvider services={workspaceGit}>
        <WorkspaceTerminalServicesProvider services={workspaceTerminals}>
          <McpTaskBridgeProvider bridge={mcpTaskBridge}>
            <McpElicitationCapabilityProvider capability={mcpElicitationCapability}>
              <McpToolsCapabilityProvider capability={mcpToolsCapability}>
                <McpStatusCapabilityProvider capability={mcpStatusCapability}>
                  <McpContentCapabilityProvider capability={mcpContentCapability}>
                    <McpAppsEnablementProvider isEnabled={mcpAppsEnabled}>
                      <ToolResultRendererProvider renderers={MCP_APP_TOOL_RESULT_RENDERERS}>
                        <DesktopHostThreadProvider>
                          <RootLayout {...sharedProps} />
                        </DesktopHostThreadProvider>
                      </ToolResultRendererProvider>
                    </McpAppsEnablementProvider>
                  </McpContentCapabilityProvider>
                </McpStatusCapabilityProvider>
              </McpToolsCapabilityProvider>
            </McpElicitationCapabilityProvider>
          </McpTaskBridgeProvider>
        </WorkspaceTerminalServicesProvider>
      </WorkspaceGitServicesProvider>
    </TokenCacheWrapper>
  );
  return nativeSearch ? (
    <NativeSearchProvider capability={nativeSearch}>{content}</NativeSearchProvider>
  ) : (
    content
  );
}
