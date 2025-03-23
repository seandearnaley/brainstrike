'use client';

import { fileSystem } from '@/lib/file/system';
import { useFileExplorerStore } from '@/stores/use-file-explorer-store';
import { useState } from 'react';

export function useFileSystem() {
  const [rootDirectoryHandle, setRootDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(
    null
  );
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const { setCurrentFolderId } = useFileExplorerStore();

  const isFileSystemAccessSupported = (): { supported: boolean; reason: string } => {
    // Check if we're in Electron
    if (typeof window.electronAPI !== 'undefined') {
      return { supported: true, reason: '' };
    }
    
    if (!window.isSecureContext) {
      return {
        supported: false,
        reason: 'File System Access API requires a secure context (HTTPS)',
      };
    }

    if (typeof window.showDirectoryPicker !== 'function') {
      return {
        supported: false,
        reason: 'File System Access API is not supported in this browser',
      };
    }

    return { supported: true, reason: '' };
  };

  // Check if running in Electron
  const isElectron = () => typeof window !== 'undefined' && !!window.electronAPI;

  const selectRootDirectory = async (): Promise<FileSystemDirectoryHandle | null> => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported && !isElectron()) {
      throw new Error(reason);
    }

    setIsAccessLoading(true);
    try {
      // Special case for Electron - use a simpler approach
      if (isElectron() && window.electronAPI) {
        // Prompt user to select directory using Electron's dialog
        const dirPath = await window.electronAPI.pickDirectory();
        
        if (!dirPath) {
          console.log('No directory selected or selection canceled');
          return null;
        }
        
        console.log('Directory selected in Electron:', dirPath);
        
        // Create a simple mock of FileSystemDirectoryHandle for electron
        const dirName = dirPath.split('/').pop() || 'root';
        const mockHandle = {
          kind: 'directory' as 'directory',
          name: dirName,
          _electronPath: dirPath, // Special property for Electron
          
          // Empty implementation that can be identified later
          async *entries() {
            // This will be replaced with electronAPI.listDirectory later
            yield ['_electron_mock_', { kind: 'file', name: '_electron_mock_'}];
          }
        };
        
        setRootDirectoryHandle(mockHandle as unknown as FileSystemDirectoryHandle);
        setCurrentFolderId(dirName);
        return mockHandle as unknown as FileSystemDirectoryHandle;
      }
      
      // Standard browser implementation
      const handle = await window.showDirectoryPicker();
      console.log('Directory selected in browser:', handle.name);
      setRootDirectoryHandle(handle);
      setCurrentFolderId(handle.name);
      return handle;
    } catch (error) {
      console.error('Error selecting directory:', error);
      if (error instanceof Error) {
        if (error.name === 'SecurityError') {
          throw new Error('Permission denied');
        }
        if (error.name === 'AbortError') {
          return null;
        }
      }
      throw error;
    } finally {
      setIsAccessLoading(false);
    }
  };

  return {
    rootDirectoryHandle,
    isAccessLoading,
    selectRootDirectory,
    isFileSystemAccessSupported,
  };
}
