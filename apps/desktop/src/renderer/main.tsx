import { AppReloadGate, startAppReloadRecovery } from '@brainstrike/app-shell/app-reload';
import { registerDurableFlush } from '@brainstrike/app-state/renderer-close';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useLoggingPreferencesStore } from '@brainstrike/app-state/stores/logging-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  PERMISSION_POLICY_STORE_VERSION,
  provideHostPermissionPolicyPersistence,
} from '@brainstrike/app-state/stores/permission-policy-store';
import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import {
  callBoundary,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFixtureCapableAdapter } from '@brainstrike/file-system';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import {
  addLogListener,
  applyLoggingPreferences,
  createLogger,
  initializeLogging,
  installConsoleGuard,
  installRendererErrorHooks,
  type LoggingPreferences,
  LogLevel,
  redactSensitiveLogValue,
} from '@brainstrike/logging';
import { initializeQueueTelemetrySink } from '@brainstrike/queue';
import { createWriteBehindStorageAdapter } from '@brainstrike/storage';
import { installPerformanceMeasureGuard } from '@brainstrike/utils/performance-measure-guard';
import { bindRuntimeLogRecord, createRuntimeLogBindings } from '@brainstrike/worker-runtime';
import { StrictMode, useEffect } from 'react';
import ReactDOM, { type Root as ReactRoot } from 'react-dom/client';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { ElectronRendererFileSystemAdapter, ElectronRendererStorageAdapter } from './adapters';
import { connectDesktopAgentHost } from './agent-host-client';
import {
  type DesktopBridgeValidationResult,
  isElectronRendererUserAgent,
  validateDesktopBridgeContract,
} from './desktop-bridge-contract';
import { resolveDesktopRendererRole } from './desktop-renderer-role';
import { hostPermissionPolicyPersistence } from './host-permission-policy';
import { createIpcCapability } from './ipc-capability';
import './log-buffer';
import './styles.css';
import { EmbeddingHostApp } from './components/embedding-host-app';

// Import layout component
import RootLayoutContent from './components/root-layout-content';
import { installDesktopRendererClose } from './desktop-renderer-close';

const desktopRendererRole = resolveDesktopRendererRole(window.location.search);
const bridgeValidation =
  desktopRendererRole === 'visible-ui'
    ? validateDesktopBridgeContract(window)
    : ({ ok: true } as const);

// Broken preloads must reach the explicit startup screen. Valid UI frames
// register their close fence before persistence can admit producer work.
if (desktopRendererRole === 'visible-ui' && bridgeValidation.ok) {
  installDesktopRendererClose();
}

// BST-1930 stage e: this window's agent host keeps the permission policy the user saves.
if (bridgeValidation.ok && window.agentHost) {
  provideHostPermissionPolicyPersistence(
    hostPermissionPolicyPersistence(connectDesktopAgentHost, PERMISSION_POLICY_STORE_VERSION)
  );
}

// Create renderer-specific adapters that use IPC
const baseFileSystemAdapter = new ElectronRendererFileSystemAdapter();
const fileSystemAdapter = createFixtureCapableAdapter(baseFileSystemAdapter, {
  platform: 'electron',
});
/**
 * Main's storage owns Explorer persistence (and the theme key). Its writes coalesce here for
 * this long, then go to Main; every document unload joins the flush (ADR-0026 R1).
 */
const STORAGE_WRITE_BEHIND_MS = 100;
const storageAdapter = createWriteBehindStorageAdapter(new ElectronRendererStorageAdapter(), {
  delayMs: STORAGE_WRITE_BEHIND_MS,
});
if (desktopRendererRole === 'visible-ui' && bridgeValidation.ok) {
  const unregisterStorageFlush = registerDurableFlush(storageAdapter.flush);
  // Under HMR this module re-executes with a new adapter; the old registration goes with it.
  import.meta.hot?.dispose(() => {
    unregisterStorageFlush();
  });
}

// Default to INFO - use LOG_LEVEL=DEBUG env var for verbose debugging
const rendererLevel = LogLevel.INFO;
const rendererConsoleLevel = LogLevel.WARN;
const rendererLogger = createLogger('DesktopRenderer');
let flushQueueTelemetry: (() => void) | null = null;
let removeHiddenHostLogForwarder: (() => void) | null = null;

const rendererRuntimeId = new URLSearchParams(window.location.search).get('runtimeId');
const rendererRuntimeKind = desktopRendererRole === 'embedding-host' ? desktopRendererRole : null;

if (typeof window !== 'undefined') {
  installConsoleGuard();
  installPerformanceMeasureGuard();
}

initializeLogging({
  appName: 'brainstrike-desktop',
  appVersion: import.meta.env['VITE_APP_VERSION'] ?? 'desktop-renderer',
  baseBindings: {
    mode: import.meta.env.MODE,
    userAgent: window.navigator.userAgent,
    windowRole: desktopRendererRole,
    ...(rendererRuntimeKind && rendererRuntimeId
      ? createRuntimeLogBindings({
          runtimeId: rendererRuntimeId,
          runtimeKind: rendererRuntimeKind,
          windowRole: desktopRendererRole,
        })
      : {}),
  },
  consoleLevel: rendererConsoleLevel,
  level: rendererLevel,
  runtime: 'electron-renderer',
});

const removeRendererErrorHooks =
  typeof window === 'undefined'
    ? () => {}
    : installRendererErrorHooks({
        onError: () => {
          flushQueueTelemetry?.();
        },
        scope: 'DesktopRenderer',
      });

const loggingStore = useLoggingPreferencesStore.getState();
if (!loggingStore.hasHydrated) {
  loggingStore.updatePreferences({
    consoleLevel: rendererConsoleLevel,
    level: rendererLevel,
  });
}

async function syncLoggingPreferencesFromMain(): Promise<void> {
  if (!window.logging?.getPreferences) {
    return;
  }
  try {
    const payload = await callBoundary(() => window.logging.getPreferences());
    useLoggingPreferencesStore.getState().setPreferences(payload.preferences);
  } catch (error) {
    rendererLogger.warn('Failed to synchronize logging preferences from main process', { error });
  }
}

void syncLoggingPreferencesFromMain();

applyLoggingPreferences(useLoggingPreferencesStore.getState().preferences, 'electron-renderer');

function sanitizeLogValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap<object, unknown>()
): unknown {
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
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing;
    }
    // Log listeners normally receive already-redacted plain records. Keep the
    // same privacy boundary if a raw Error reaches this transport seam instead
    // of duplicating the logger's non-enumerable cause and sensitive-key rules.
    // The redactor returns a detached plain graph and closes its own cycles, so
    // recursion cannot revisit this raw Error before it is safe to memoize.
    const result = sanitizeLogValue(redactSensitiveLogValue(value), seen);
    seen.set(value, result);
    return result;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) {
      result.push(sanitizeLogValue(entry, seen));
    }
    return result;
  }
  if (typeof value === 'object') {
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeLogValue(entry, seen);
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
            runtimeId: rendererRuntimeId,
            runtimeKind: rendererRuntimeKind,
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
          runtimeId: rendererRuntimeId,
          runtimeKind: rendererRuntimeKind,
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
        metadata: {
          app: 'desktop-renderer',
          mode: import.meta.env.MODE,
          version: import.meta.env['VITE_APP_VERSION'] ?? 'desktop-renderer',
        },
        runtime: 'electron-renderer',
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
      enableCatalogModels: (modelIds: readonly string[]) => Promise<void>;
      indexSearch?: IndexSearchCapability;
      notifySecretsChanged: () => void;
      setAssistantModel: (compositeKey: string) => void;
    };
  }
}

/** A failed-chunk reload goes through Main, which flushes this document before replacing it. */
function requestDocumentReload(): void {
  const lifecycle = window.desktopLifecycle;
  if (!lifecycle) {
    throw new Error('The desktop reload capability is unavailable');
  }
  void lifecycle.requestReload('failed-chunk-recovery').catch((cause: unknown) => {
    rendererLogger.error('Desktop reload request was refused', { cause });
  });
}

function App() {
  // biome-ignore lint/plugin: Fires a one-time DOM event on mount to signal the desktop app is ready.
  useEffect(() => {
    if (!window.__BRAINSTRIKE_READY__) {
      window.__BRAINSTRIKE_READY__ = true;
    }

    window.dispatchEvent(new Event('brainstrike:ready'));
  }, []);

  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
      return;
    }

    window.__brainstrikeTestHooks__ = {
      // BST-2242: through the renderer's catalog store, as Settings and the
      // picker's Enable write, so the composer sees the committed snapshot.
      enableCatalogModels: async (modelIds) => {
        if (!window.modelCatalog) {
          throw new Error('The desktop model catalog capability is unavailable');
        }
        const catalog = createBoundaryCapability<ModelCatalogCapability>(window.modelCatalog);
        await useModelRegistryStore.getState().ensureRegistry(catalog);
        await useModelRegistryStore.getState().setModelsEnabled(catalog, modelIds, true);
      },
      // Functional fixtures use the production consumer adapter; window.indexSearch remains the raw transport.
      ...(window.indexSearch
        ? { indexSearch: createIpcCapability(window.indexSearch, indexSearchContract) }
        : {}),
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
    <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
      <AppReloadGate buildId={__BRAINSTRIKE_BUILD_ID__} reload={requestDocumentReload}>
        <RootLayoutContent />
      </AppReloadGate>
    </AdaptersProvider>
  );
}

function DesktopStartupFailure({
  validation,
}: {
  validation: Exclude<DesktopBridgeValidationResult, { ok: true }>;
}) {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[#0b1020] px-6 py-10 text-[#eef2ff]"
      data-testid="desktop-startup-failure"
    >
      <div className="w-full max-w-3xl rounded-xl border border-red-400/30 bg-[#111827] p-6 shadow-2xl">
        <h1 className="font-semibold text-2xl">Desktop startup failed</h1>
        <p className="mt-3 text-slate-200 text-sm">{validation.message}</p>
        <p className="mt-3 text-slate-300 text-sm">
          Check the Electron startup logs. If this happens in development, the preload script or a
          required preload dependency failed before the renderer mounted.
        </p>
        <div className="mt-4">
          <h2 className="font-medium text-slate-200 text-sm">Missing bridges</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-red-200 text-sm">
            {validation.missing.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function DesktopRendererOutsideElectron() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[#0b1020] px-6 py-10 text-[#eef2ff]"
      data-testid="desktop-renderer-outside-electron"
    >
      <div className="w-full max-w-3xl rounded-xl border border-amber-400/30 bg-[#111827] p-6 shadow-2xl">
        <h1 className="font-semibold text-2xl">Desktop renderer opened outside Electron</h1>
        <p className="mt-3 text-slate-200 text-sm">
          This page is the BrainStrike desktop renderer. It relies on Electron preload bridges that
          do not exist in a regular browser, so it cannot run here.
        </p>
        <p className="mt-3 text-slate-300 text-sm">
          This is not a desktop app failure — the Electron windows attached to this dev server are
          unaffected. Close this tab and use the Electron app window.
        </p>
      </div>
    </div>
  );
}

function isEmbeddingHostMode(): boolean {
  return new URLSearchParams(window.location.search).get('mode') === 'embedding-host';
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

// A failed contract inside Electron means the preload script broke — keep that
// loudly fatal. The same page opened in a plain browser tab (routine against
// the shared dev server during `dev:agent-debug`) has no preload by design;
// classify it separately so the console error is never misread as an Electron
// boot failure. See desktop-bridge-contract.ts for why the user agent is the
// right classifier here.
const runningInElectron = isElectronRendererUserAgent(window.navigator.userAgent);

if (!bridgeValidation.ok) {
  if (runningInElectron) {
    rendererLogger.error('Desktop preload bridge contract validation failed', {
      missing: bridgeValidation.missing,
    });
  } else {
    rendererLogger.error(
      'Desktop renderer loaded outside Electron — preload bridges cannot exist here. This is not a desktop app failure; close this browser tab and use the Electron window.',
      { userAgent: window.navigator.userAgent }
    );
  }
}

// Only the window that renders the shell can offer a reload; the hidden hosts have no UI.
// Before the first render, so a marker the last reload left has already flagged the
// notice. Under HMR this module re-executes: the uninstall keeps one listener.
if (desktopRendererRole === 'visible-ui') {
  const stopAppReloadRecovery = startAppReloadRecovery({ buildId: __BRAINSTRIKE_BUILD_ID__ });
  if (import.meta.hot) {
    import.meta.hot.dispose(stopAppReloadRecovery);
  }
}

root.render(
  bridgeValidation.ok ? (
    isEmbeddingHostMode() ? (
      <EmbeddingHostApp />
    ) : (
      <StrictMode>
        <App />
      </StrictMode>
    )
  ) : runningInElectron ? (
    <DesktopStartupFailure validation={bridgeValidation} />
  ) : (
    <DesktopRendererOutsideElectron />
  )
);
