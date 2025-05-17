import { ErrorBoundary } from '@brainstrike/ui';
import React, { Suspense, useState, useEffect } from 'react';

// Loading fallback component
function FileExplorerLoading() {
  return <div className="p-4 text-center">Loading File Explorer...</div>;
}

// Error fallback component
function FileSystemNotSupported() {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">File System Access</h2>
      <p className="mb-4">
        The File System Access API is not supported in this browser or environment. Please use a
        modern browser like Chrome, Edge, or Opera.
      </p>
    </div>
  );
}

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
          <div className="p-4 text-red-500">
            Failed to load File Explorer component. Please check the console for details.
          </div>
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
    return <FileSystemNotSupported />;
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<FileExplorerLoading />}>
        <FileExplorer />
      </Suspense>
    </ErrorBoundary>
  );
}
