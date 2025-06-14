import { createFolderService } from '@brainstrike/file-cache';
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

// Initialize database services
const folderService = createFolderService();

// Create web adapters with database support
const fileSystemAdapter = createFileSystemAdapter('web', {
  folderService,
  databaseMode: true,
});
const storageAdapter = createStorageAdapter('web');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HelmetProvider>
      <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
        <RootLayoutContent />
      </AdaptersProvider>
    </HelmetProvider>
  </React.StrictMode>
);
