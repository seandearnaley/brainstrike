import './configure-browser-runtime';
import { DiagnosticSinkBridge } from '@brainstrike/app-shell/diagnostics';
import { useLoggingPreferencesStore } from '@brainstrike/app-state/stores/logging-preferences-store';
import { resolveBootstrapTreeSitterLanguages } from '@brainstrike/chunking-worker';
import { EPHEMERAL_WEB_E2E_DATA_DIR_PREFIX, getDefaultBrowserPGliteDataDir } from '@brainstrike/db';
import { DbProvider } from '@brainstrike/db/react';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFixtureCapableAdapter, createWebFileSystemAdapter } from '@brainstrike/file-system';
import {
  applyLoggingPreferences,
  initializeLogging,
  installConsoleGuard,
  installRendererErrorHooks,
  LogLevel,
} from '@brainstrike/logging';
import { initializeQueueTelemetrySink } from '@brainstrike/queue';
import { DbSchemaVerifier } from '@brainstrike/settings-ui/components/db-schema-verifier';
import { createBrowserStorageAdapter } from '@brainstrike/storage';
import { installPerformanceMeasureGuard } from '@brainstrike/utils/performance-measure-guard';
import React from 'react';
import ReactDOM, { type Root as ReactRoot } from 'react-dom/client';
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

// Engine-versioned (idb://web-pg18) so the Postgres 18 upgrade boots a clean
// directory instead of failing to open a PG17 on-disk database.
const DEFAULT_WEB_DB_PATH = getDefaultBrowserPGliteDataDir('web');
const E2E_DB_PATH_SESSION_KEY = 'brainstrike.e2e.dbPath.v1';
// Intentionally NOT engine-versioned (no `-pg18`): each Playwright session mints a
// fresh UUID and a CI run pins a single engine, so an e2e store never has to be
// opened across engine majors — the greenfield versioning that protects the real
// `web-pg18` path is unnecessary here. Note the trade-off: because the base name
// doesn't end in `-pg<N>`, `reclaimLegacyBrowserPGliteStorage` will NOT sweep
// abandoned `web-e2e-*` stores; they're reclaimed only by factory-reset enumeration.
// The prefix is owned by @brainstrike/db: the PGlite worker loader relaxes
// durability for exactly these throwaway stores (they die with the Playwright
// context), keeping strict durability on the real `web-pg18` path.
const E2E_DB_PATH_PREFIX = EPHEMERAL_WEB_E2E_DATA_DIR_PREFIX;

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
  appName: 'brainstrike-web',
  appVersion: import.meta.env['VITE_APP_VERSION'] ?? 'dev',
  baseBindings: {
    mode: import.meta.env.MODE,
  },
  consoleLevel: defaultLevel,
  level: defaultLevel,
  runtime: 'browser',
});

const removeRendererErrorHooks =
  typeof window === 'undefined'
    ? () => {}
    : installRendererErrorHooks({
        onError: () => {
          flushQueueTelemetry?.();
        },
        scope: 'WebRenderer',
      });

const loggingStore = useLoggingPreferencesStore.getState();
if (!loggingStore.hasHydrated) {
  loggingStore.updatePreferences({
    consoleLevel: defaultLevel,
    level: defaultLevel,
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
        metadata: {
          app: 'web',
          mode: import.meta.env.MODE,
          version: import.meta.env['VITE_APP_VERSION'] ?? 'dev',
        },
        runtime: 'browser',
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
    <DbProvider dbPath={webDbPath}>
      <DiagnosticSinkBridge source="web-renderer" />
      <WebE2ETestHooks dbPath={webDbPath} />
      <DbSchemaVerifier>
        <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
          <RootLayoutContent />
        </AdaptersProvider>
      </DbSchemaVerifier>
    </DbProvider>
  </React.StrictMode>
);
