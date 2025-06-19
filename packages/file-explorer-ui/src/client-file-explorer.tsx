import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { FileExplorerErrorBoundary, FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { createFileSystemAdapter } from '@brainstrike/file-system';
import { createStorageAdapter } from '@brainstrike/storage';
import { ErrorFallback, LoadingFallback, UnsupportedFeature } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import React, { Suspense, useState, useEffect, useMemo } from 'react';

const logger = createLogger('ClientFileExplorer');

// Lazy load the file explorer component with better error handling for Vite
const FileExplorer = React.lazy(() => {
  return import('./file-explorer')
    .then((module) => {
      return module;
    })
    .catch((err) => {
      logger.error('Error loading FileExplorer:', err);
      // Return a fallback component
      return {
        default: () => (
          <ErrorFallback message="Failed to load File Explorer component. Please check the console for details." />
        ),
      };
    });
});

export default function ClientFileExplorer() {
  const [isSupported, setIsSupported] = useState(true);

  // Create adapters for the web platform, memoized to prevent re-creation on re-renders
  const fileSystemAdapter = useMemo(() => createFileSystemAdapter('web'), []);
  const storageAdapter = useMemo(() => createStorageAdapter('web'), []);

  useEffect(() => {
    // Check if File System Access API is supported
    const checkSupport = () => {
      try {
        if (!window.isSecureContext) {
          logger.warn('File System Access API requires a secure context (HTTPS)');
          setIsSupported(false);
          return;
        }

        if (typeof window.showDirectoryPicker !== 'function') {
          logger.warn('File System Access API is not supported in this browser');
          setIsSupported(false);
          return;
        }

        setIsSupported(true);
      } catch (err) {
        logger.error('Error checking File System API support:', err);
        setIsSupported(false);
      }
    };

    checkSupport();
  }, []);

  if (!isSupported) {
    return (
      <UnsupportedFeature
        title="File System Access"
        description="The File System Access API is not supported in this browser or environment. Please use a modern browser like Chrome, Edge, or Opera."
      />
    );
  }

  return (
    <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
      <FileExplorerProvider storageAdapter={storageAdapter}>
        <FileExplorerErrorBoundary>
          <Suspense fallback={<LoadingFallback message="Loading File Explorer..." />}>
            <FileExplorer />
          </Suspense>
        </FileExplorerErrorBoundary>
      </FileExplorerProvider>
    </AdaptersProvider>
  );
}
