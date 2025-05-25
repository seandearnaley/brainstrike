import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import type { IFileNode } from '@brainstrike/types';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles.css';

import HomePageContent from './components/home-page-content';
// Import layout and page components from web app structure
import RootLayoutContent from './components/root-layout-content';
import SettingsPageContent from './components/settings/page-content';

// Electron renderer adapters that use the preload API
class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    return window.electronAPI.fs.requestDirectoryAccess();
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    return window.electronAPI.fs.readDirectory(handle);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return window.electronAPI.fs.readFile(handle);
  }

  async exists(path: string): Promise<boolean> {
    return window.electronAPI.fs.exists(path);
  }
}

class ElectronRendererStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return window.electronAPI.storage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    return window.electronAPI.storage.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return window.electronAPI.storage.removeItem(key);
  }

  async clear(): Promise<void> {
    return window.electronAPI.storage.clear();
  }

  async getAllKeys(): Promise<string[]> {
    return window.electronAPI.storage.getAllKeys();
  }
}

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
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<RootLayoutContent />}>
              <Route index element={<HomePageContent />} />
              <Route path="settings" element={<SettingsPageContent />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </HelmetProvider>
    </AdaptersProvider>
  </React.StrictMode>
);
