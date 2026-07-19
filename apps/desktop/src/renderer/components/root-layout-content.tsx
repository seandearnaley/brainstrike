// Capability check from the dependency-light `availability` subpath (NOT
// `/git-panel`, which also re-exports GitPanel + @codemirror/merge) so the
// startup check does not defeat the lazy code-split in git-page-content.tsx.
import { isGitBridgeAvailable } from '@brainstrike/app-shell/git-panel/availability';
import { navigationItems } from '@brainstrike/app-shell/navigation';
import {
  type RootLayoutContentProps,
  RootLayoutContent as SharedRootLayoutContent,
} from '@brainstrike/app-shell/root-layout-content';
// Capability check from the dependency-light `availability` subpath (NOT
// `/terminal-panel`, which also re-exports TerminalPanel + @xterm/*) so the
// startup check does not defeat the lazy code-split in terminal-page-content.tsx.
import { isTerminalBridgeAvailable } from '@brainstrike/app-shell/terminal-panel/availability';
import type { NavigationItem } from '@brainstrike/app-shell/types';
import { usePGliteDatabase } from '@brainstrike/db';
import { TokenCacheProvider } from '@brainstrike/file-explorer-ui/indexing';
// Capability check from the dependency-light `availability` subpath (NOT
// `/panel`) so the startup check does not defeat the lazy code-split in
// notes-page-content.tsx.
import { isNotesVaultAvailable } from '@brainstrike/notes-vault/availability';
import { createLogger } from '@brainstrike/utils/logger';
import { GitBranch, NotebookPen, SquareTerminal } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { registerDesktopEmbeddingRuntimeConfig } from '../create-embedding-queue';
import ContextExplorerPageContent from './context-explorer-page-content';
import GitPageContent from './git-page-content';
import NotesPageContent from './notes-page-content';
import SettingsPageContent from './settings/page-content';
import TerminalPageContent from './terminal-page-content';

const GIT_NAVIGATION_ITEM: NavigationItem = { icon: GitBranch, name: 'Git', path: '/git' };
const NOTES_NAVIGATION_ITEM: NavigationItem = { icon: NotebookPen, name: 'Notes', path: '/notes' };
const TERMINAL_NAVIGATION_ITEM: NavigationItem = {
  icon: SquareTerminal,
  name: 'Terminal',
  path: '/terminal',
};

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
  const db = usePGliteDatabase();
  return <TokenCacheProvider db={db}>{children}</TokenCacheProvider>;
}

/**
 * Desktop app root layout component.
 *
 * CRITICAL: This component creates the embedding queue flow for the entire app:
 *
 * 1. create-embedding-queue.ts is resolved lazily when DB/vector tooling needs it
 * 2. Passed to SharedRootLayoutContent as loadEmbeddingQueue prop
 * 3. Flows through RootLayoutContent → AgentSidebarPanel → DatabasePanel → DatabaseTab → DatabaseDemoPanel
 * 4. Database-facing views use it for embedding set management and import operations
 *
 * DO NOT remove the loadEmbeddingQueue prop! It's the single source of truth for all
 * embedding operations in the desktop app.
 *
 * TOKEN CACHE: The TokenCacheWrapper provides a shared token cache context that
 * enables background token indexing. It wraps the entire layout so both:
 * - FileExplorerPanel (indexes selected files via background worker)
 * - PreviewPanel in ContextExplorerPageContent (displays token counts from the shared cache)
 * can share the same context and see each other's updates.
 */
export default function RootLayoutContent() {
  const db = usePGliteDatabase();
  const activeToolsTabRef = useRef<'database-ready' | 'initializing'>(
    db ? 'database-ready' : 'initializing'
  );
  activeToolsTabRef.current = db ? 'database-ready' : 'initializing';

  // Capability gate: only surface the Git tab when the desktop `window.git`
  // bridge is present (no isElectron check). The bridge exists before React
  // mounts, so this is stable for the window's lifetime — resolve it once.
  const gitAvailable = useMemo(() => isGitBridgeAvailable(), []);
  // Capability gate: only surface the Terminal tab when the desktop
  // `window.terminal` pty bridge is present (no isElectron check). Resolved once.
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
  // Capability gate: only surface the Notes tab when the File System Access
  // directory picker exists in this renderer (Electron >= 30). Resolved once.
  const notesAvailable = useMemo(() => isNotesVaultAvailable(), []);
  const navigationConfig = useMemo<NavigationItem[]>(() => {
    const items = [...(navigationItems as NavigationItem[])];
    if (notesAvailable) {
      items.push(NOTES_NAVIGATION_ITEM);
    }
    if (gitAvailable) {
      items.push(GIT_NAVIGATION_ITEM);
    }
    if (terminalAvailable) {
      items.push(TERMINAL_NAVIGATION_ITEM);
    }
    return items;
  }, [gitAvailable, terminalAvailable, notesAvailable]);
  const loadEmbeddingQueue = useCallback(
    () => import('../create-embedding-queue').then((module) => module.getEmbeddingQueue()),
    []
  );

  // CRITICAL: loadEmbeddingQueue from create-embedding-queue.ts must be passed through
  // so the queue stays singleton while avoiding startup-time workerpool construction.
  const sharedProps: RootLayoutContentProps = {
    contextExplorerPageContent: <ContextExplorerPageContent />,
    databaseTabChunkingMode: 'host-proxy',
    navigationItems: navigationConfig,
    settingsPageContent: <SettingsPageContent />,
    ...(gitAvailable ? { gitPageContent: <GitPageContent /> } : {}),
    ...(notesAvailable ? { notesPageContent: <NotesPageContent /> } : {}),
    ...(terminalAvailable ? { terminalPageContent: <TerminalPageContent /> } : {}),
    loadEmbeddingQueue, // DO NOT REMOVE - See function docstring
  };
  const RootLayout = SharedRootLayoutContent as (props: RootLayoutContentProps) => ReactElement;

  // Eagerly register the embedding runtime config + LAZY queue factory
  // (mirrors web's registerWebEmbeddingRuntimeConfig): a local-model semantic
  // search initializes the transformers backend from the visible renderer, and
  // without this registration it throws "Embedding queue factory is not
  // registered" until a database panel happens to load the queue.
  useEffect(() => {
    registerDesktopEmbeddingRuntimeConfig();
  }, []);

  useEffect(() => {
    logger.info('Desktop database runtime availability changed', {
      databaseReady: Boolean(db),
    });
  }, [db]);

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

  return (
    <TokenCacheWrapper>
      <RootLayout {...sharedProps} />
    </TokenCacheWrapper>
  );
}
