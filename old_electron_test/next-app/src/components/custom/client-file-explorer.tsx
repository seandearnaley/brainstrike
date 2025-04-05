'use client';

import dynamic from 'next/dynamic';
import ErrorBoundary from './error-boundary';

const FileExplorer = dynamic(() => import('./file-explorer'), {
  ssr: false,
});

export default function ClientFileExplorer() {
  return (
    <ErrorBoundary>
      <FileExplorer />
    </ErrorBoundary>
  );
}
