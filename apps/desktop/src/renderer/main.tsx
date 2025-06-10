import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { startPersistenceWorker } from '../../../../packages/file-explorer/src';
import { ElectronRendererFileSystemAdapter, ElectronRendererStorageAdapter } from './adapters';
import './styles.css';

// Import layout component
import RootLayoutContent from './components/root-layout-content';

// Electron renderer adapters are defined in a separate module

// Create renderer-specific adapters that use IPC
const fileSystemAdapter = new ElectronRendererFileSystemAdapter();
const storageAdapter = new ElectronRendererStorageAdapter();
startPersistenceWorker();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
      <RootLayoutContent />
    </AdaptersProvider>
  </React.StrictMode>
);
