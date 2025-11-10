import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFixtureCapableAdapter } from '@brainstrike/file-system';
import { useLoggingPreferencesStore } from '@brainstrike/preferences';
import { initializeQueueTelemetrySink } from '@brainstrike/queue';
import {
  applyLoggingPreferences,
  initializeLogging,
  installConsoleGuard,
  LogLevel,
} from '@brainstrike/utils';
import React, { useEffect, useState } from 'react';
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

const rendererLevel = import.meta.env.DEV ? LogLevel.DEBUG : LogLevel.INFO;

if (typeof window !== 'undefined') {
  installConsoleGuard();
}

initializeLogging({
  runtime: 'electron-renderer',
  level: rendererLevel,
  consoleLevel: rendererLevel,
  appName: 'brainstrike-desktop',
  appVersion: import.meta.env.VITE_APP_VERSION ?? 'desktop-renderer',
  baseBindings: {
    mode: import.meta.env.MODE,
    userAgent: window.navigator.userAgent,
  },
});

const loggingStore = useLoggingPreferencesStore.getState();
if (!loggingStore.hasHydrated) {
  loggingStore.updatePreferences({
    level: rendererLevel,
    consoleLevel: rendererLevel,
  });
}

applyLoggingPreferences(useLoggingPreferencesStore.getState().preferences, 'electron-renderer');

const unsubscribeLoggingPreferences = useLoggingPreferencesStore.subscribe((state) => {
  applyLoggingPreferences(state.preferences, 'electron-renderer');
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeLoggingPreferences();
  });
}

const telemetryEndpoint = import.meta.env.VITE_QUEUE_TELEMETRY_ENDPOINT;
const rendererTelemetrySink =
  typeof window !== 'undefined' && telemetryEndpoint
    ? initializeQueueTelemetrySink({
        endpoint: telemetryEndpoint,
        ...(import.meta.env.VITE_QUEUE_TELEMETRY_API_KEY
          ? { apiKey: import.meta.env.VITE_QUEUE_TELEMETRY_API_KEY }
          : {}),
        runtime: 'electron-renderer',
        metadata: {
          app: 'desktop-renderer',
          mode: import.meta.env.MODE,
          version: import.meta.env.VITE_APP_VERSION ?? 'desktop-renderer',
        },
      })
    : null;

if (rendererTelemetrySink) {
  const flushTelemetry = () => {
    void rendererTelemetrySink.flush();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flushTelemetry);
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', flushTelemetry);
      }
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
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="text-lg font-semibold">Initializing Database...</div>
          <div className="text-sm text-muted-foreground mt-2">
            Setting up PGlite with persistent storage
          </div>
        </div>
      </div>
    );
  }

  return (
    <DbProvider useElectronIPC={true} dbPath={dbPath}>
      <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
        <RootLayoutContent />
      </AdaptersProvider>
    </DbProvider>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
