import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { ChunkingWorkerProvider } from '@brainstrike/file-import';
import { createFixtureCapableAdapter } from '@brainstrike/file-system';
import { DbSchemaVerifier, useLoggingPreferencesStore } from '@brainstrike/preferences';
import { initializeQueueTelemetrySink } from '@brainstrike/queue';
import type { LoggingPreferences } from '@brainstrike/utils';
import {
  applyLoggingPreferences,
  createLogger,
  initializeLogging,
  installConsoleGuard,
  installPerformanceMeasureGuard,
  installRendererErrorHooks,
  LogLevel,
} from '@brainstrike/utils';
import { StrictMode, useEffect } from 'react';
import ReactDOM, { type Root as ReactRoot } from 'react-dom/client';
import { ElectronRendererFileSystemAdapter, ElectronRendererStorageAdapter } from './adapters';
import './styles.css';

// Import layout component
import RootLayoutContent from './components/root-layout-content';

// Create renderer-specific adapters that use IPC
const baseFileSystemAdapter = new ElectronRendererFileSystemAdapter();
const fileSystemAdapter = createFixtureCapableAdapter(baseFileSystemAdapter, {
  platform: 'electron',
});
const storageAdapter = new ElectronRendererStorageAdapter();

// Default to INFO - use LOG_LEVEL=DEBUG env var for verbose debugging
const rendererLevel = LogLevel.INFO;
const rendererLogger = createLogger('DesktopRenderer');
let flushQueueTelemetry: (() => void) | null = null;

if (typeof window !== 'undefined') {
  installConsoleGuard();
  installPerformanceMeasureGuard();
}

initializeLogging({
  runtime: 'electron-renderer',
  level: rendererLevel,
  consoleLevel: rendererLevel,
  appName: 'brainstrike-desktop',
  appVersion: import.meta.env['VITE_APP_VERSION'] ?? 'desktop-renderer',
  baseBindings: {
    mode: import.meta.env.MODE,
    userAgent: window.navigator.userAgent,
  },
});

const removeRendererErrorHooks =
  typeof window !== 'undefined'
    ? installRendererErrorHooks({
        scope: 'DesktopRenderer',
        onError: () => {
          flushQueueTelemetry?.();
        },
      })
    : () => {};

const loggingStore = useLoggingPreferencesStore.getState();
if (!loggingStore.hasHydrated) {
  loggingStore.updatePreferences({
    level: rendererLevel,
    consoleLevel: rendererLevel,
  });
}

async function syncLoggingPreferencesFromMain(): Promise<void> {
  if (!window.logging?.getPreferences) {
    return;
  }
  try {
    const payload = await window.logging.getPreferences();
    useLoggingPreferencesStore.getState().setPreferences(payload.preferences);
  } catch (error) {
    rendererLogger.warn('Failed to synchronize logging preferences from main process', { error });
  }
}

void syncLoggingPreferencesFromMain();

applyLoggingPreferences(useLoggingPreferencesStore.getState().preferences, 'electron-renderer');

const unsubscribeLoggingPreferences = useLoggingPreferencesStore.subscribe((state) => {
  applyLoggingPreferences(state.preferences, 'electron-renderer');
});

const unsubscribeLoggingEvents =
  window.logging?.onPreferencesUpdated?.((preferences: LoggingPreferences) => {
    useLoggingPreferencesStore.getState().setPreferences(preferences);
  }) ?? null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeLoggingPreferences();
    unsubscribeLoggingEvents?.();
    removeRendererErrorHooks();
  });
}

const telemetryEndpoint = import.meta.env['VITE_QUEUE_TELEMETRY_ENDPOINT'];
const rendererTelemetrySink =
  typeof window !== 'undefined' && telemetryEndpoint
    ? initializeQueueTelemetrySink({
        endpoint: telemetryEndpoint,
        useSendBeacon: false,
        ...(import.meta.env['VITE_QUEUE_TELEMETRY_API_KEY']
          ? { apiKey: import.meta.env['VITE_QUEUE_TELEMETRY_API_KEY'] }
          : {}),
        runtime: 'electron-renderer',
        metadata: {
          app: 'desktop-renderer',
          mode: import.meta.env.MODE,
          version: import.meta.env['VITE_APP_VERSION'] ?? 'desktop-renderer',
        },
      })
    : null;

if (rendererTelemetrySink) {
  const flushTelemetry = () => {
    void rendererTelemetrySink.flush();
  };
  flushQueueTelemetry = flushTelemetry;
  const handleBeforeUnload = () => {
    flushTelemetry();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload);
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      }
      flushQueueTelemetry = null;
      void rendererTelemetrySink.dispose();
    });
  }
}

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: Shared global sentinel uses double underscores for clarity
    __BRAINSTRIKE_READY__?: boolean;
    // biome-ignore lint/style/useNamingConvention: Shared global sentinel uses double underscores for clarity
    __BRAINSTRIKE_DESKTOP_REACT_ROOT__?: ReactRoot;
  }
}

function App() {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/a67c7242-fa95-40d2-befe-f4f7a66bce86', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b4e51e' },
    body: JSON.stringify({
      sessionId: 'b4e51e',
      location: 'main.tsx:App',
      message: 'App component rendering',
      data: {},
      hypothesisId: 'H1,H4',
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  // Use IndexedDB storage for desktop app (renderer process can't access filesystem directly)
  const dbPath = 'idb://brainstrike-desktop';

  // biome-ignore lint/plugin: Fires a one-time DOM event on mount to signal the desktop app is ready.
  useEffect(() => {
    if (!window.__BRAINSTRIKE_READY__) {
      window.__BRAINSTRIKE_READY__ = true;
    }

    window.dispatchEvent(new Event('brainstrike:ready'));
  }, []);

  return (
    <DbProvider dbPath={dbPath} useElectronIPC={true}>
      <DbSchemaVerifier>
        <ChunkingWorkerProvider>
          <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
            <RootLayoutContent />
          </AdaptersProvider>
        </ChunkingWorkerProvider>
      </DbSchemaVerifier>
    </DbProvider>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

const existingRoot = window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__;

// #region agent log
fetch('http://127.0.0.1:7242/ingest/a67c7242-fa95-40d2-befe-f4f7a66bce86', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b4e51e' },
  body: JSON.stringify({
    sessionId: 'b4e51e',
    location: 'main.tsx:mount',
    message: 'React root mounting',
    data: { hasExistingRoot: !!existingRoot },
    hypothesisId: 'H1',
    timestamp: Date.now(),
  }),
}).catch(() => {});
// #endregion

const root = existingRoot ?? ReactDOM.createRoot(rootElement);
if (!existingRoot) {
  window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__ = root;
}

root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
