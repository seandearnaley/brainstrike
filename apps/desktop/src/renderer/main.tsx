import { DiagnosticSinkBridge } from '@brainstrike/app-shell/diagnostics';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useLoggingPreferencesStore } from '@brainstrike/app-state/stores/logging-preferences-store';
import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import { resolveBootstrapTreeSitterLanguages } from '@brainstrike/chunking-worker';
import { DbProvider } from '@brainstrike/db/react';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFixtureCapableAdapter } from '@brainstrike/file-system';
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
import { DbSchemaVerifier } from '@brainstrike/settings-ui/components/db-schema-verifier';
import { installPerformanceMeasureGuard } from '@brainstrike/utils/performance-measure-guard';
import { bindRuntimeLogRecord, createRuntimeLogBindings } from '@brainstrike/worker-runtime';
import { StrictMode, Suspense, useEffect } from 'react';
import ReactDOM, { type Root as ReactRoot } from 'react-dom/client';
import { ElectronRendererFileSystemAdapter, ElectronRendererStorageAdapter } from './adapters';
import { McpTaskStatusE2eHarness } from './components/mcp-task-status-e2e-harness-lazy';
import {
  type DesktopBridgeValidationResult,
  isElectronRendererUserAgent,
  validateDesktopBridgeContract,
} from './desktop-bridge-contract';
import { resolveDesktopRendererRole } from './desktop-renderer-role';
import './log-buffer';
import './styles.css';
import { ChunkingHostApp } from './components/chunking-host-app';
import { EmbeddingHostApp } from './components/embedding-host-app';
import { LlmHostApp } from './components/llm-host-app';

// Local declaration of the parser-routing globals exposed by the chunking
// worker (see packages/chunking-worker/src/parsers/environment.ts). Declared
// here as well so apps/desktop's renderer can set them without a runtime
// dep on @brainstrike/chunking-worker. Both sides agree on the names by
// convention; if they ever diverge the chunking worker's selectAdapter
// silently falls back to its 'browser' default.
declare global {
  var __BRAINSTRIKE_PARSER_ENV__: 'browser' | 'electron-chunking-host' | undefined;
  var __BRAINSTRIKE_PARSER_FLAG__: 'auto' | 'babel' | 'oxc' | undefined;
  var __BRAINSTRIKE_TREE_SITTER_LANGUAGES__: readonly string[] | undefined;
}

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

const desktopRendererRole = resolveDesktopRendererRole(
  window.location.search,
  window.desktopLifecycle?.isTestMode === true
);
const rendererRuntimeId = new URLSearchParams(window.location.search).get('runtimeId');
const rendererRuntimeKind =
  desktopRendererRole === 'embedding-host' ||
  desktopRendererRole === 'chunking-host' ||
  desktopRendererRole === 'llm-host'
    ? desktopRendererRole
    : null;

// Phase 8 rollout + P1 #994 fix: when this renderer is the chunking host,
// read the optional URL-param kill switch into globalThis for the
// chunking-worker provider to propagate to the worker via init message.
//
// The parser ENVIRONMENT itself is auto-detected downstream: the
// chunking-worker-port's buildInitMessage checks for `globalThis.parserHost`
// (exposed by preload's contextBridge in this renderer) and tells the
// worker to advertise itself as electron-chunking-host. Setting
// __BRAINSTRIKE_PARSER_ENV__ on `window` here used to do nothing useful —
// the worker has its own globalThis realm — so it's removed.
//
// Operator kill switch: append `?parserFlag=babel` to the chunking-host
// renderer URL to force the legacy Babel path. The chunking-host's URL is
// constructed in chunking-host-manager.ts when launching the BrowserWindow,
// so this is a one-line change there if the rollout needs to be reverted
// in the field.
if (desktopRendererRole === 'chunking-host') {
  const flagParam = new URLSearchParams(window.location.search).get('parserFlag');
  if (flagParam === 'babel' || flagParam === 'oxc' || flagParam === 'auto') {
    globalThis.__BRAINSTRIKE_PARSER_FLAG__ = flagParam;
  }

  // Tree-sitter rollout (Phase 8 of #998): enable Python by default in the
  // chunking-host. Operator kill switch: append `?treeSitterLanguages=`
  // (empty) to disable, or `?treeSitterLanguages=python,rust` to specify
  // a custom list. The renderer's URL is built in chunking-host-manager.ts
  // so this is a one-line change there if the rollout needs to be reverted
  // in the field. The helper centralizes the parse + default logic and is
  // unit-tested in chunking-worker/src/__tests__/tree-sitter-rollout.test.ts.
  // The chunking-worker-port's buildInitMessage forwards this to the worker
  // realm via the existing init message, same pattern as parserEnv/parserFlag.
  globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = resolveBootstrapTreeSitterLanguages(
    window.location.search
  );
}

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
    const payload = await window.logging.getPreferences();
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
      notifySecretsChanged: () => void;
      setAssistantModel: (compositeKey: string) => void;
    };
  }
}

// Desktop main → renderer durable-record push (Task 6): window.logging is a
// static preload global, so this is computed once at module scope rather
// than as an inline object literal inside App's render — an inline literal
// is a new reference on every render, and DiagnosticSinkBridge's effect
// depends on forwardedRecords by reference, so it would tear down and
// rebuild the writer (dispose, re-purge, resubscribe) on every App re-render.
const forwardedDiagnosticRecords =
  typeof window.logging?.onDurableRecord === 'function'
    ? { subscribe: window.logging.onDurableRecord }
    : undefined;

function App() {
  // With useElectronIPC below, the renderer routes all DB ops to the main-process
  // filesystem PGlite (engine-versioned via the pg-data-version guard). This idb
  // path is just a stable IPC-channel identifier — no renderer-side PGlite database
  // is opened here, so it intentionally is NOT engine-versioned like idb://app-pg18.
  const dbPath = 'idb://brainstrike-desktop';

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
      <DiagnosticSinkBridge
        forwardedRecords={forwardedDiagnosticRecords}
        source="desktop-renderer"
      />
      <DbSchemaVerifier>
        <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
          <RootLayoutContent />
        </AdaptersProvider>
      </DbSchemaVerifier>
    </DbProvider>
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
          unaffected. Close this tab and use the Electron app window, or run the web app (apps/web)
          for a browser experience.
        </p>
      </div>
    </div>
  );
}

function isEmbeddingHostMode(): boolean {
  return new URLSearchParams(window.location.search).get('mode') === 'embedding-host';
}

function isChunkingHostMode(): boolean {
  return new URLSearchParams(window.location.search).get('mode') === 'chunking-host';
}

function isLlmHostMode(): boolean {
  return new URLSearchParams(window.location.search).get('mode') === 'llm-host';
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

const bridgeValidation =
  desktopRendererRole === 'visible-ui'
    ? validateDesktopBridgeContract({
        electronAPI: window.electronAPI,
        logging: window.logging,
      })
    : ({ ok: true } as const);

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
      'Desktop renderer loaded outside Electron — preload bridges cannot exist here. This is not a desktop app failure; close this browser tab and use the Electron window (or apps/web for the browser app).',
      { userAgent: window.navigator.userAgent }
    );
  }
}

root.render(
  bridgeValidation.ok ? (
    isEmbeddingHostMode() ? (
      <EmbeddingHostApp />
    ) : isChunkingHostMode() ? (
      <ChunkingHostApp />
    ) : isLlmHostMode() ? (
      <LlmHostApp />
    ) : desktopRendererRole === 'mcp-task-harness' ? (
      McpTaskStatusE2eHarness === null ? (
        <div data-testid="mcp-task-harness-unavailable" role="alert">
          MCP Tasks verifier is not built into this renderer (VITE_MCP_TASK_HARNESS unset).
        </div>
      ) : (
        <Suspense fallback={<div role="status">Loading MCP Tasks verifier…</div>}>
          <McpTaskStatusE2eHarness />
        </Suspense>
      )
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
