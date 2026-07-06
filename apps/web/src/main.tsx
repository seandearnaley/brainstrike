import { resolveBootstrapTreeSitterLanguages } from '@brainstrike/chunking-worker';
import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFixtureCapableAdapter, createWebFileSystemAdapter } from '@brainstrike/file-system';
import { DbSchemaVerifier } from '@brainstrike/preferences/components/db-schema-verifier';
import { useLoggingPreferencesStore } from '@brainstrike/preferences/stores/logging-preferences-store';
import { initializeQueueTelemetrySink } from '@brainstrike/queue';
import { createBrowserStorageAdapter } from '@brainstrike/storage';
import { installConsoleGuard } from '@brainstrike/utils/console-guard';
import { installRendererErrorHooks } from '@brainstrike/utils/install-renderer-error-hooks';
import { LogLevel } from '@brainstrike/utils/logger';
import { initializeLogging } from '@brainstrike/utils/logging-initializer';
import { applyLoggingPreferences } from '@brainstrike/utils/logging-preferences';
import { installPerformanceMeasureGuard } from '@brainstrike/utils/performance-measure-guard';
import React from 'react';
import ReactDOM, { type Root as ReactRoot } from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import { resolveWebDbPath, resolveWebDbRuntimeSelection } from './db-runtime';
import { WebE2ETestHooks } from './web-e2e-test-hooks';
// Import global CSS
import './app/globals.css';

// Import layout component
import RootLayoutContent from './app/root-layout-content';

// Create web adapters
const baseFileSystemAdapter = createWebFileSystemAdapter();
const fileSystemAdapter = createFixtureCapableAdapter(baseFileSystemAdapter, { platform: 'web' });
const storageAdapter = createBrowserStorageAdapter();

// Default to INFO in development - use LOG_LEVEL=DEBUG env var for verbose debugging
const defaultLevel = LogLevel.INFO;
let flushQueueTelemetry: (() => void) | null = null;

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: Shared global sentinel uses double underscores for clarity
    __BRAINSTRIKE_WEB_REACT_ROOT__?: ReactRoot;
  }
  var __BRAINSTRIKE_TREE_SITTER_LANGUAGES__: readonly string[] | undefined;
}

// Tree-sitter rollout (Phase 8 of #998): default-enable Python on web too.
// apps/web bundles the python.wasm grammar via Phase 4's vite static-copy;
// chunking happens in the web worker. The helper centralizes default-vs-
// kill-switch logic (tested in tree-sitter-rollout.test.ts). Operator
// override: append `?treeSitterLanguages=` (empty) to disable or
// `?treeSitterLanguages=python,rust` for a custom list.
//
// Set BEFORE any code that might import the chunking-worker — the worker
// itself runs in a separate realm but the chunking-worker-port forwards
// this global through its init message.
globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = resolveBootstrapTreeSitterLanguages(
  window.location.search
);

if (typeof window !== 'undefined') {
  installConsoleGuard();
  installPerformanceMeasureGuard();
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
  typeof window === 'undefined'
    ? () => {}
    : installRendererErrorHooks({
        scope: 'WebRenderer',
        onError: () => {
          flushQueueTelemetry?.();
        },
      });

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

const telemetryEndpoint = import.meta.env['VITE_QUEUE_TELEMETRY_ENDPOINT'];
const telemetrySink =
  typeof window !== 'undefined' && telemetryEndpoint
    ? initializeQueueTelemetrySink({
        endpoint: telemetryEndpoint,
        useSendBeacon: false,
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

const existingRoot = window.__BRAINSTRIKE_WEB_REACT_ROOT__;
const root = existingRoot ?? ReactDOM.createRoot(rootElement);
if (!existingRoot) {
  window.__BRAINSTRIKE_WEB_REACT_ROOT__ = root;
}

// A7 browser cutover (2026-07-05): the web runtime selection is resolved ONCE
// at boot, defaulting to Turso browser WASM; VITE_BRAINSTRIKE_DB_RUNTIME=pglite
// is the explicit opt-out and a malformed value throws here (see db-runtime.ts).
const webDbRuntimeSelection = resolveWebDbRuntimeSelection(
  import.meta.env['VITE_BRAINSTRIKE_DB_RUNTIME']
);
const webDbPath = resolveWebDbPath(webDbRuntimeSelection.engine);

root.render(
  <React.StrictMode>
    <HelmetProvider>
      <DbProvider dbPath={webDbPath} runtimeSelection={webDbRuntimeSelection}>
        <WebE2ETestHooks dbPath={webDbPath} />
        <DbSchemaVerifier>
          <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
            <RootLayoutContent />
          </AdaptersProvider>
        </DbSchemaVerifier>
      </DbProvider>
    </HelmetProvider>
  </React.StrictMode>
);
