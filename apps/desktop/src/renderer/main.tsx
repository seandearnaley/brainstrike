import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFixtureCapableAdapter } from '@brainstrike/file-system';
import {
  DbSchemaVerifier,
  useAssistantPreferencesStore,
  useLoggingPreferencesStore,
  useSecretsStore,
} from '@brainstrike/preferences';
import { initializeQueueTelemetrySink } from '@brainstrike/queue';
import type { LoggingPreferences } from '@brainstrike/utils';
import {
  addLogListener,
  applyLoggingPreferences,
  createLogger,
  initializeLogging,
  installConsoleGuard,
  installPerformanceMeasureGuard,
  installRendererErrorHooks,
  LogLevel,
} from '@brainstrike/utils';
import { bindRuntimeLogRecord, createRuntimeLogBindings } from '@brainstrike/worker-runtime';
import { StrictMode, useEffect } from 'react';
import ReactDOM, { type Root as ReactRoot } from 'react-dom/client';
import { ElectronRendererFileSystemAdapter, ElectronRendererStorageAdapter } from './adapters';
import './log-buffer';
import './styles.css';
import { ChunkingHostApp } from './components/chunking-host-app';
import { EmbeddingHostApp } from './components/embedding-host-app';

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
const rendererConsoleLevel = LogLevel.WARN;
const rendererLogger = createLogger('DesktopRenderer');
let flushQueueTelemetry: (() => void) | null = null;
let removeHiddenHostLogForwarder: (() => void) | null = null;

type DesktopRendererRole = 'chunking-host' | 'embedding-host' | 'visible-ui';

function getDesktopRendererRole(): DesktopRendererRole {
  const mode = new URLSearchParams(window.location.search).get('mode');
  if (mode === 'embedding-host') {
    return 'embedding-host';
  }
  if (mode === 'chunking-host') {
    return 'chunking-host';
  }
  return 'visible-ui';
}

const desktopRendererRole = getDesktopRendererRole();
const rendererRuntimeId = new URLSearchParams(window.location.search).get('runtimeId');
const rendererRuntimeKind =
  desktopRendererRole === 'embedding-host' || desktopRendererRole === 'chunking-host'
    ? desktopRendererRole
    : null;

if (typeof window !== 'undefined') {
  installConsoleGuard();
  installPerformanceMeasureGuard();
}

initializeLogging({
  runtime: 'electron-renderer',
  level: rendererLevel,
  consoleLevel: rendererConsoleLevel,
  appName: 'brainstrike-desktop',
  appVersion: import.meta.env['VITE_APP_VERSION'] ?? 'desktop-renderer',
  baseBindings: {
    mode: import.meta.env.MODE,
    userAgent: window.navigator.userAgent,
    windowRole: desktopRendererRole,
    ...(rendererRuntimeKind && rendererRuntimeId
      ? createRuntimeLogBindings({
          runtimeKind: rendererRuntimeKind,
          runtimeId: rendererRuntimeId,
          windowRole: desktopRendererRole,
        })
      : {}),
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
    consoleLevel: rendererConsoleLevel,
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

function sanitizeLogValue(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValue(entry));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeLogValue(entry);
    }
    return result;
  }
  return String(value);
}

if (desktopRendererRole !== 'visible-ui') {
  removeHiddenHostLogForwarder = addLogListener((record) => {
    const runtimeAwareRecord =
      rendererRuntimeKind && rendererRuntimeId
        ? bindRuntimeLogRecord(record, {
            runtimeKind: rendererRuntimeKind,
            runtimeId: rendererRuntimeId,
            windowRole: desktopRendererRole,
          })
        : record;

    window.logging?.ingestBufferedRecord?.({
      ...runtimeAwareRecord,
      args: runtimeAwareRecord.args.map((arg) => sanitizeLogValue(arg)),
      bindings: Object.fromEntries(
        Object.entries(runtimeAwareRecord.bindings).map(([key, value]) => [
          key,
          sanitizeLogValue(value),
        ])
      ),
    });
  });
  rendererLogger.info('Background renderer log forwarding enabled', {
    windowRole: desktopRendererRole,
    ...(rendererRuntimeKind && rendererRuntimeId
      ? createRuntimeLogBindings({
          runtimeKind: rendererRuntimeKind,
          runtimeId: rendererRuntimeId,
          windowRole: desktopRendererRole,
        })
      : {}),
  });
}

const unsubscribeLoggingPreferences = useLoggingPreferencesStore.subscribe((state) => {
  applyLoggingPreferences(state.preferences, 'electron-renderer');
});

const unsubscribeLoggingEvents =
  window.logging?.onPreferencesUpdated?.((preferences: LoggingPreferences) => {
    useLoggingPreferencesStore.getState().setPreferences(preferences);
  }) ?? null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeHiddenHostLogForwarder?.();
    removeHiddenHostLogForwarder = null;
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
    __BRAINSTRIKE_DESKTOP_REACT_ROOT__?: ReactRoot;
    // biome-ignore lint/style/useNamingConvention: Shared global sentinel uses double underscores for clarity
    __BRAINSTRIKE_READY__?: boolean;
    __brainstrikeTestHooks__?: {
      notifySecretsChanged: () => void;
      setAssistantModel: (compositeKey: string) => void;
    };
  }
}

function App() {
  // Use IndexedDB storage for desktop app (renderer process can't access filesystem directly)
  const dbPath = 'idb://brainstrike-desktop';

  // biome-ignore lint/plugin: Fires a one-time DOM event on mount to signal the desktop app is ready.
  useEffect(() => {
    if (!window.__BRAINSTRIKE_READY__) {
      window.__BRAINSTRIKE_READY__ = true;
    }

    window.dispatchEvent(new Event('brainstrike:ready'));
  }, []);

  useEffect(() => {
    if (!window.navigator.webdriver) {
      return;
    }

    window.__brainstrikeTestHooks__ = {
      notifySecretsChanged: () => {
        useSecretsStore.getState().notifySecretsChanged();
      },
      setAssistantModel: (compositeKey: string) => {
        useAssistantPreferencesStore.getState().setModel(compositeKey);
      },
    };

    return () => {
      window.__brainstrikeTestHooks__ = undefined;
    };
  }, []);

  return (
    <DbProvider dbPath={dbPath} useElectronIPC={true}>
      <DbSchemaVerifier>
        <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
          <RootLayoutContent />
        </AdaptersProvider>
      </DbSchemaVerifier>
    </DbProvider>
  );
}

function isEmbeddingHostMode(): boolean {
  return new URLSearchParams(window.location.search).get('mode') === 'embedding-host';
}

function isChunkingHostMode(): boolean {
  return new URLSearchParams(window.location.search).get('mode') === 'chunking-host';
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

const existingRoot = window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__;

const root = existingRoot ?? ReactDOM.createRoot(rootElement);
if (!existingRoot) {
  window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__ = root;
}

root.render(
  isEmbeddingHostMode() ? (
    <EmbeddingHostApp />
  ) : isChunkingHostMode() ? (
    <ChunkingHostApp />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  )
);
