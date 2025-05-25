import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { ElectronRendererFileSystemAdapter, ElectronRendererStorageAdapter } from './adapters';
import './styles.css';

import HomePageContent from './components/home-page-content';
// Import layout and page components from web app structure
import RootLayoutContent from './components/root-layout-content';
import SettingsPageContent from './components/settings/page-content';

// Electron renderer adapters are defined in a separate module

// Create renderer-specific adapters that use IPC
const fileSystemAdapter = new ElectronRendererFileSystemAdapter();
const storageAdapter = new ElectronRendererStorageAdapter();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Failed to find the root element with ID 'root'");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
      <HelmetProvider>
        <HashRouter>
          <Routes>
            <Route path="/" element={<RootLayoutContent />}>
              <Route index element={<HomePageContent />} />
              <Route path="settings" element={<SettingsPageContent />} />
            </Route>
          </Routes>
        </HashRouter>
      </HelmetProvider>
    </AdaptersProvider>
  </React.StrictMode>
);
