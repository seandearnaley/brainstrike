import { FileExplorerErrorBoundary } from '@brainstrike/file-explorer-ui';
import { ErrorFallback, LoadingFallback, UnsupportedFeature } from '@brainstrike/ui';
import React, { Suspense, useState, useEffect } from 'react';

// Lazy load the file explorer component with better error handling for Vite
const FileExplorer = React.lazy(() => {
  console.log('Attempting to load FileExplorer component...');
  return import('./file-explorer')
    .then((module) => {
      console.log('FileExplorer component loaded successfully');
      return module;
    })
    .catch((err) => {
      console.error('Error loading FileExplorer:', err);
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

  useEffect(() => {
    // Check if File System Access API is supported
    const checkSupport = () => {
      try {
        if (!window.isSecureContext) {
          console.warn('File System Access API requires a secure context (HTTPS)');
          setIsSupported(false);
          return;
        }

        if (typeof window.showDirectoryPicker !== 'function') {
          console.warn('File System Access API is not supported in this browser');
          setIsSupported(false);
          return;
        }

        setIsSupported(true);
      } catch (err) {
        console.error('Error checking File System API support:', err);
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
    <FileExplorerErrorBoundary>
      <Suspense fallback={<LoadingFallback message="Loading File Explorer..." />}>
        <FileExplorer />
      </Suspense>
    </FileExplorerErrorBoundary>
  );
}
