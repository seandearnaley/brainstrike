import { DbProvider } from '@brainstrike/db';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
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
    // For Electron renderer, we need to use IndexedDB since PGlite WASM
    // runs in a browser-like environment and can't access the file system directly
    setDbPath('idb://desktop');
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
