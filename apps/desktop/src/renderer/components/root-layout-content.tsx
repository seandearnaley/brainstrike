// Capability check from the dependency-light `availability` subpath (NOT
// `/changes`, which also re-exports ChangesSurface + the diff renderer) so
// the startup check does not defeat the lazy code-split in
// changes-page-content.tsx.
import { isBrowserBridgeAvailable } from '@brainstrike/app-shell/browser-pane/availability';
import { BrowserPaneContent } from '@brainstrike/app-shell/browser-pane/browser-pane-content';
import { CanvasPanel } from '@brainstrike/app-shell/canvas/canvas-panel';
import { isChangesBridgeAvailable } from '@brainstrike/app-shell/changes/availability';
// Capability check from the dependency-light `availability` subpath (NOT
// `/git-panel`, which also re-exports GitPanel + @codemirror/merge) so the
// startup check does not defeat the lazy code-split in git-page-content.tsx.
import { isGitBridgeAvailable } from '@brainstrike/app-shell/git-panel/availability';
import { McpContentCapabilityProvider } from '@brainstrike/app-shell/mcp-content-capability';
import { McpStatusCapabilityProvider } from '@brainstrike/app-shell/mcp-status-capability';
import { McpToolsCapabilityProvider } from '@brainstrike/app-shell/mcp-tools-capability';
import { navigationItems } from '@brainstrike/app-shell/navigation';
import NotesPageContent from '@brainstrike/app-shell/notes-page-content';
import {
  type RootLayoutContentProps,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell/root-layout-content';
// Capability check from the dependency-light `availability` subpath (NOT
// `/terminal-panel`, which also re-exports TerminalPanel + @xterm/*) so the
// startup check does not defeat the lazy code-split in terminal-page-content.tsx.
import { isTerminalBridgeAvailable } from '@brainstrike/app-shell/terminal-panel/availability';
import type { NavigationItem } from '@brainstrike/app-shell/types';
import { isWorktreesBridgeAvailable } from '@brainstrike/app-shell/worktrees/availability';
import { McpTaskBridgeProvider } from '@brainstrike/assistant-ui/mcp-task-bridge-context';
import { ToolResultRendererProvider } from '@brainstrike/assistant-ui/tool-result-renderer-context';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui/indexing';
import { createLogger } from '@brainstrike/logging';
import { McpAppsEnablementProvider, mcpAppToolResultRenderer } from '@brainstrike/mcp-app-host-ui';
// Capability check from the dependency-light `availability` subpath (NOT
// `/panel`) so the startup check does not defeat the lazy code-split in
// `@brainstrike/app-shell/notes-page-content`.
import { isNotesVaultAvailable } from '@brainstrike/notes-vault/availability';
import { McpElicitationCapabilityProvider } from '@brainstrike/settings-ui/settings/tools/mcp-elicitation-capability';
import { GitBranch, Globe, NotebookPen } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef } from 'react';
import { DesktopHostThreadProvider } from '../desktop-host-thread-provider';
import {
  resolveDesktopMcpContent,
  resolveDesktopMcpElicitationBridge,
  resolveDesktopMcpStatusCapability,
  resolveDesktopMcpTaskBridge,
  resolveDesktopMcpToolsCapability,
} from '../host-mcp-settings';
import { useMcpAppsEnablement } from '../use-mcp-apps-enablement';
// Task A's changes-page-content.tsx exports this by name (not default,
// unlike its git/context-explorer/terminal siblings) — imported as written.
import { ChangesPageContent } from './changes-page-content';
import ContextExplorerPageContent from './context-explorer-page-content';
import GitPageContent from './git-page-content';
import { NativeSearchProvider } from './native-search-provider';
import SettingsPageContent from './settings/page-content';
import TerminalPageContent from './terminal-page-content';
import { WorktreeMapPageContent } from './worktree-map-page-content';

const BROWSER_NAVIGATION_ITEM: NavigationItem = { icon: Globe, name: 'Browser', path: '/browser' };
const GIT_NAVIGATION_ITEM: NavigationItem = { icon: GitBranch, name: 'Git', path: '/git' };
const NOTES_NAVIGATION_ITEM: NavigationItem = { icon: NotebookPen, name: 'Notes', path: '/notes' };

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
  return <TokenCacheProvider db={null}>{children}</TokenCacheProvider>;
}

/** Stable identity: the provider value must not change between renders. */
const MCP_APP_TOOL_RESULT_RENDERERS = Object.freeze([mcpAppToolResultRenderer]);

/** Desktop shell; the host owns persistence and hidden hosts own inference. */
export default function RootLayoutContent() {
  const activeToolsTabRef = useRef('host-owned');

  // Capability gate: only surface the Changes tab when the desktop
  // `window.changes` bridge is present (no isElectron check). Resolved once.
  const changesAvailable = useMemo(() => isChangesBridgeAvailable(), []);
  // Capability gate: only surface the Git tab when the desktop `window.git`
  // bridge is present (no isElectron check). The bridge exists before React
  // mounts, so this is stable for the window's lifetime — resolve it once.
  const gitAvailable = useMemo(() => isGitBridgeAvailable(), []);
  // Capability gate: only surface the Terminal tab when the desktop
  // `window.terminal` pty bridge is present (no isElectron check). Resolved once.
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
  // Capability gate: only surface the Worktrees tab when the desktop
  // `window.worktrees` bridge is present. Resolved once.
  const worktreesAvailable = useMemo(() => isWorktreesBridgeAvailable(), []);
  // Capability gate: only surface the Notes tab when the File System Access
  // directory picker exists in this renderer (Electron >= 30). Resolved once.
  const notesAvailable = useMemo(() => isNotesVaultAvailable(), []);
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
    const items = [...navigationItems];
    if (notesAvailable) {
      items.push(NOTES_NAVIGATION_ITEM);
    }
    if (gitAvailable) {
      items.push(GIT_NAVIGATION_ITEM);
    }
    if (browserAvailable) {
      items.push(BROWSER_NAVIGATION_ITEM);
    }
    return items;
  }, [gitAvailable, notesAvailable, browserAvailable]);
  const sharedProps: RootLayoutContentProps = {
    // Canvas render surface (BST-1173): needs only the DB (summaries/versions)
    // and the brainstrike-canvas: shell protocol, both unconditionally present
    // on desktop — no bridge gate.
    canvasPanelContent: <CanvasPanel shellSrc="brainstrike-canvas://shell/" />,
    contextExplorerPageContent: <ContextExplorerPageContent />,
    databaseTabChunkingMode: 'host-proxy',
    deleteRootData: (rootId) => {
      const bridge = window.electronAPI;
      if (!(bridge && 'fileSystem' in bridge)) {
        throw new Error('Desktop root data deletion bridge is unavailable.');
      }
      return bridge.fileSystem.deleteRootData(rootId);
    },
    nativeIndexSearch: window.indexSearch ?? null,
    navigationItems: navigationConfig,
    settingsPageContent: <SettingsPageContent />,
    ...(browserAvailable ? { browserPageContent: <BrowserPaneContent /> } : {}),
    ...(changesAvailable ? { changesPageContent: <ChangesPageContent /> } : {}),
    ...(gitAvailable ? { gitPageContent: <GitPageContent /> } : {}),
    ...(notesAvailable ? { notesPageContent: <NotesPageContent /> } : {}),
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
    </TokenCacheWrapper>
  );
  return window.indexSearch ? (
    <NativeSearchProvider capability={window.indexSearch}>{content}</NativeSearchProvider>
  ) : (
    content
  );
}
