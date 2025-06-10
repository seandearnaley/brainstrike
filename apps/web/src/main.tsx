import { createFileExplorerStore } from '@brainstrike/file-explorer';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { createFileSystemAdapter } from '@brainstrike/file-system';
import { createStorageAdapter } from '@brainstrike/storage';
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
const fileExplorerStore = createFileExplorerStore(storageAdapter);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HelmetProvider>
      <AdaptersProvider
        fileSystemAdapter={fileSystemAdapter}
        storageAdapter={storageAdapter}
        fileExplorerStore={fileExplorerStore}
      >
        <RootLayoutContent />
      </AdaptersProvider>
    </HelmetProvider>
  </React.StrictMode>
);
