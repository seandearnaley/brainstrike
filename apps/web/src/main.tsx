import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { ChunkingWorkerProvider } from '@brainstrike/file-import';
import { createFileSystemAdapter, createFixtureCapableAdapter } from '@brainstrike/file-system';
import { useLoggingPreferencesStore } from '@brainstrike/preferences';
import { initializeQueueTelemetrySink } from '@brainstrike/queue';
import { createStorageAdapter } from '@brainstrike/storage';
import {
  applyLoggingPreferences,
  initializeLogging,
  installConsoleGuard,
  installRendererErrorHooks,
  LogLevel,
} from '@brainstrike/utils';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
// Import global CSS
import './app/globals.css';

// Import layout component
import RootLayoutContent from './app/root-layout-content';

// Create web adapters
const baseFileSystemAdapter = createFileSystemAdapter('web');
const fileSystemAdapter = createFixtureCapableAdapter(baseFileSystemAdapter, { platform: 'web' });
const storageAdapter = createStorageAdapter('web');

const defaultLevel = import.meta.env.DEV ? LogLevel.DEBUG : LogLevel.INFO;
let flushQueueTelemetry: (() => void) | null = null;

if (typeof window !== 'undefined') {
  installConsoleGuard();
}

initializeLogging({
  runtime: 'browser',
  level: defaultLevel,
  consoleLevel: defaultLevel,
  appName: 'brainstrike-web',
  appVersion: import.meta.env['VITE_APP_VERSION'] ?? 'dev',
  baseBindings: {
    mode: import.meta.env.MODE,
  },
});

const removeRendererErrorHooks =
  typeof window !== 'undefined'
    ? installRendererErrorHooks({
        scope: 'WebRenderer',
        onError: () => {
          flushQueueTelemetry?.();
        },
      })
    : () => {};

const loggingStore = useLoggingPreferencesStore.getState();
if (!loggingStore.hasHydrated) {
  loggingStore.updatePreferences({
    level: defaultLevel,
    consoleLevel: defaultLevel,
  });
}

applyLoggingPreferences(useLoggingPreferencesStore.getState().preferences, 'browser');

const unsubscribeLoggingPreferences = useLoggingPreferencesStore.subscribe((state) => {
  applyLoggingPreferences(state.preferences, 'browser');
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeLoggingPreferences();
    removeRendererErrorHooks();
  });
}

const telemetryEndpoint =
  import.meta.env['VITE_QUEUE_TELEMETRY_ENDPOINT'] ??
  (import.meta.env.DEV ? 'http://localhost:4130/queue-telemetry' : undefined);
const telemetrySink =
  typeof window !== 'undefined' && telemetryEndpoint
    ? initializeQueueTelemetrySink({
        endpoint: telemetryEndpoint,
        ...(import.meta.env['VITE_QUEUE_TELEMETRY_API_KEY']
          ? { apiKey: import.meta.env['VITE_QUEUE_TELEMETRY_API_KEY'] }
          : {}),
        runtime: 'browser',
        metadata: {
          app: 'web',
          mode: import.meta.env.MODE,
          version: import.meta.env['VITE_APP_VERSION'] ?? 'dev',
        },
      })
    : null;

if (telemetrySink) {
  const flushTelemetry = () => {
    void telemetrySink.flush();
  };
  flushQueueTelemetry = flushTelemetry;
  const handleBeforeUnload = () => {
    flushTelemetry();
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flushTelemetry();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      }
      flushQueueTelemetry = null;
      void telemetrySink.dispose();
    });
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HelmetProvider>
      <DbProvider dbPath="idb://web">
        <ChunkingWorkerProvider>
          <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
            <RootLayoutContent />
          </AdaptersProvider>
        </ChunkingWorkerProvider>
      </DbProvider>
    </HelmetProvider>
  </React.StrictMode>
);
