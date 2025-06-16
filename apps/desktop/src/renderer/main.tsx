import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ElectronRendererFileSystemAdapter, ElectronRendererStorageAdapter } from './adapters';
import './styles.css';

// Import layout component
import RootLayoutContent from './components/root-layout-content';

// Electron renderer adapters are defined in a separate module

// Create renderer-specific adapters that use IPC
const fileSystemAdapter = new ElectronRendererFileSystemAdapter();
const storageAdapter = new ElectronRendererStorageAdapter();

function App() {
  const [dbPath, setDbPath] = useState<string | null>(null);

  useEffect(() => {
    const getDbPath = async () => {
      try {
        const userDataPath = await window.electronAPI.getUserDataPath();
        setDbPath(userDataPath);
      } catch (error) {
        console.error('Failed to get user data path:', error);
        // Fallback to IndexedDB for desktop app
        setDbPath('idb://desktop');
      }
    };

    getDbPath();
  }, []);

  if (!dbPath) {
    return <div>Loading...</div>;
  }

  return (
    <DbProvider dbPath={dbPath}>
      <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
        <RootLayoutContent />
      </AdaptersProvider>
    </DbProvider>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
