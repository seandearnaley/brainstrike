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
  installRendererErrorHooks,
  LogLevel,
} from '@brainstrike/utils';
import { StrictMode, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
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

const telemetryEndpoint =
  import.meta.env['VITE_QUEUE_TELEMETRY_ENDPOINT'] ??
  (import.meta.env.DEV ? 'http://localhost:4130/queue-telemetry' : undefined);
const rendererTelemetrySink =
  typeof window !== 'undefined' && telemetryEndpoint
    ? initializeQueueTelemetrySink({
        endpoint: telemetryEndpoint,
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
  }
}

function App() {
  const [dbPath, setDbPath] = useState<string | null>(null);

  useEffect(() => {
    // Use IndexedDB storage for desktop app (renderer process can't access filesystem directly)
    setDbPath('idb://brainstrike-desktop');
  }, []);

  useEffect(() => {
    if (!dbPath) {
      return;
    }

    if (!window.__BRAINSTRIKE_READY__) {
      window.__BRAINSTRIKE_READY__ = true;
    }

    window.dispatchEvent(new Event('brainstrike:ready'));
  }, [dbPath]);

  if (!dbPath) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="font-semibold text-lg">Initializing Database...</div>
          <div className="mt-2 text-muted-foreground text-sm">
            Setting up PGlite with persistent storage
          </div>
        </div>
      </div>
    );
  }

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

ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
