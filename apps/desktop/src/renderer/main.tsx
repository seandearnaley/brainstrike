import { AppReloadGate, startAppReloadRecovery } from '@brainstrike/app-shell/app-reload';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
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
  applyLoggingPreferences,
  createLogger,
  initializeLogging,
  installConsoleGuard,
  installRendererErrorHooks,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import { installPerformanceMeasureGuard } from '@brainstrike/utils/performance-measure-guard';
import { StrictMode, useEffect } from 'react';
import ReactDOM, { type Root as ReactRoot } from 'react-dom/client';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { ElectronRendererFileSystemAdapter } from './adapters';
import { connectDesktopAgentHost } from './agent-host-client';
import {
  type DesktopBridgeValidationResult,
  isElectronRendererUserAgent,
  validateDesktopBridgeContract,
} from './desktop-bridge-contract';
import { windowHostConnection } from './desktop-host-connection';
import { hostPermissionPolicyPersistence } from './host-permission-policy';
import { createIpcCapability } from './ipc-capability';
import './log-buffer';
import { useAppUpdateReadyToast } from './use-app-update-ready-toast';
import './styles.css';

// Import layout component
import RootLayoutContent from './components/root-layout-content';
import { installDesktopRendererClose } from './desktop-renderer-close';

const bridgeValidation = validateDesktopBridgeContract(window);

// Broken preloads must reach the explicit startup screen. Valid UI frames
// register their close fence before persistence can admit producer work.
if (bridgeValidation.ok) {
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
// Default to INFO - use LOG_LEVEL=DEBUG env var for verbose debugging
const rendererLevel = LogLevel.INFO;
const rendererConsoleLevel = LogLevel.WARN;
const rendererLogger = createLogger('DesktopRenderer');

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
  },
  consoleLevel: rendererConsoleLevel,
  level: rendererLevel,
  runtime: 'electron-renderer',
});

const removeRendererErrorHooks =
  typeof window === 'undefined'
    ? () => {}
    : installRendererErrorHooks({ scope: 'DesktopRenderer' });

// Main owns logging preferences: the renderer applies what Main holds now and every change Main broadcasts.
async function applyLoggingPreferencesFromMain(): Promise<void> {
  if (!window.logging?.getPreferences) {
    return;
  }
  try {
    const payload = await callBoundary(() => window.logging.getPreferences());
    applyLoggingPreferences(payload.preferences, 'electron-renderer');
  } catch (error) {
    rendererLogger.warn('Failed to read logging preferences from main process', { error });
  }
}

void applyLoggingPreferencesFromMain();

const unsubscribeLoggingEvents =
  window.logging?.onPreferencesUpdated?.((preferences: LoggingPreferences) => {
    applyLoggingPreferences(preferences, 'electron-renderer');
  }) ?? null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeLoggingEvents?.();
    removeRendererErrorHooks();
  });
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
      /** Test mode: one request on this window's agent host connection, as its views send it. */
      requestAgentHost: (method: string, params: unknown) => Promise<unknown>;
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
  useAppUpdateReadyToast();

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
      requestAgentHost: async (method, params) => {
        const client = await windowHostConnection().current();
        // The host decodes the method and its params; a test that names a wrong one is refused there.
        const request = client.request as (method: string, params: unknown) => Promise<unknown>;
        return await request.call(client, method, params);
      },
      setAssistantModel: (compositeKey: string) => {
        useAssistantPreferencesStore.getState().setModel(compositeKey);
      },
    };

    return () => {
      Reflect.deleteProperty(window, '__brainstrikeTestHooks__');
    };
  }, []);

  return (
    <AdaptersProvider fileSystemAdapter={fileSystemAdapter}>
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
      className="relative flex min-h-screen items-center justify-center bg-[#0b1020] px-6 py-10 text-[#eef2ff]"
      data-testid="desktop-startup-failure"
    >
      {/* No app shell here, so this strip is the macOS title bar: it moves the window. */}
      <div
        aria-hidden="true"
        className="app-window-drag absolute inset-x-0 top-0 h-[env(titlebar-area-height,0px)]"
      />
      <div className="w-full max-w-3xl rounded-xl border border-red-400/30 bg-[#111827] p-6 shadow-2xl">
        <h1 className="text-2xl font-semibold">Desktop startup failed</h1>
        <p className="mt-3 text-sm text-slate-200">{validation.message}</p>
        <p className="mt-3 text-sm text-slate-300">
          Check the Electron startup logs. If this happens in development, the preload script or a
          required preload dependency failed before the renderer mounted.
        </p>
        <div className="mt-4">
          <h2 className="text-sm font-medium text-slate-200">Missing bridges</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-200">
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
        <h1 className="text-2xl font-semibold">Desktop renderer opened outside Electron</h1>
        <p className="mt-3 text-sm text-slate-200">
          This page is the Brainstrike desktop renderer. It relies on Electron preload bridges that
          do not exist in a regular browser, so it cannot run here.
        </p>
        <p className="mt-3 text-sm text-slate-300">
          This is not a desktop app failure — the Electron windows attached to this dev server are
          unaffected. Close this tab and use the Electron app window.
        </p>
      </div>
    </div>
  );
}

const rootElement = document.querySelector('#root');
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

// Before the first render, so a marker the last reload left has already flagged the
// notice. Under HMR this module re-executes: the uninstall keeps one listener.
const stopAppReloadRecovery = startAppReloadRecovery({ buildId: __BRAINSTRIKE_BUILD_ID__ });
if (import.meta.hot) {
  import.meta.hot.dispose(stopAppReloadRecovery);
}

root.render(
  bridgeValidation.ok ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : runningInElectron ? (
    <DesktopStartupFailure validation={bridgeValidation} />
  ) : (
    <DesktopRendererOutsideElectron />
  )
);
