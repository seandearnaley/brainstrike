import { useLoggingPreferencesStore } from '@brainstrike/app-shell';
import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFileSystemAdapter } from '@brainstrike/file-system';
import { createStorageAdapter } from '@brainstrike/storage';
import {
  applyLoggingPreferences,
  initializeLogging,
  installConsoleGuard,
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
const fileSystemAdapter = createFileSystemAdapter('web');
const storageAdapter = createStorageAdapter('web');

const defaultLevel = import.meta.env.DEV ? LogLevel.DEBUG : LogLevel.INFO;

if (typeof window !== 'undefined') {
  installConsoleGuard();
}

initializeLogging({
  runtime: 'browser',
  level: defaultLevel,
  consoleLevel: defaultLevel,
  appName: 'brainstrike-web',
  appVersion: import.meta.env.VITE_APP_VERSION ?? 'dev',
  baseBindings: {
    mode: import.meta.env.MODE,
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
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HelmetProvider>
      <DbProvider dbPath="idb://web">
        <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
          <RootLayoutContent />
        </AdaptersProvider>
      </DbProvider>
    </HelmetProvider>
  </React.StrictMode>
);
