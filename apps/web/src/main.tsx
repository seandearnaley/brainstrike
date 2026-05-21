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

const DEFAULT_WEB_DB_PATH = 'idb://web';
const E2E_DB_PATH_SESSION_KEY = 'brainstrike.e2e.dbPath.v1';
const E2E_DB_PATH_PREFIX = 'idb://web-e2e-';

function createE2eDbPath(): string {
  if (typeof window.crypto?.randomUUID !== 'function') {
    throw new Error('Playwright web E2E database isolation requires crypto.randomUUID');
  }

  return `${E2E_DB_PATH_PREFIX}${window.crypto.randomUUID()}`;
}

function resolveWebDbPath(): string {
  if (window.navigator.webdriver !== true) {
    return DEFAULT_WEB_DB_PATH;
  }

  const existingPath = window.sessionStorage.getItem(E2E_DB_PATH_SESSION_KEY);
  if (existingPath?.startsWith(E2E_DB_PATH_PREFIX)) {
    return existingPath;
  }

  const dbPath = createE2eDbPath();
  window.sessionStorage.setItem(E2E_DB_PATH_SESSION_KEY, dbPath);
  return dbPath;
}

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

const webDbPath = resolveWebDbPath();

root.render(
  <React.StrictMode>
    <HelmetProvider>
      <DbProvider dbPath={webDbPath}>
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
