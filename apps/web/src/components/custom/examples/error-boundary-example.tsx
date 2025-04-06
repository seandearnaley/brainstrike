import {
  ConcurrentLoadingError,
  FSInitializationError,
  FileContentError,
  GitOperationError,
  PartialRefreshError,
} from '@brainstrike/types';
import { useState } from 'react';
import { Button } from '../../ui/button';
import ErrorBoundary from '../error-boundary';

// Component that demonstrates different error scenarios
const ErrorThrower = ({ errorType }: { errorType: string }) => {
  // Throw different types of errors based on the errorType prop
  switch (errorType) {
    case 'fs-init':
      throw new FSInitializationError('Failed to access file system', 'PERMISSION_DENIED');
    case 'file-content':
      throw new FileContentError(
        'File exceeds maximum size limit',
        '/path/to/large/file.txt',
        'TOO_LARGE'
      );
    case 'git':
      throw new GitOperationError('Authentication failed', 'clone');
    case 'partial-refresh':
      throw new PartialRefreshError('Some files failed to refresh', 15, 3);
    case 'concurrent-loading':
      throw new ConcurrentLoadingError('Too many concurrent file operations', [
        '/path/file1.txt',
        '/path/file2.txt',
      ]);
    case 'generic':
      throw new Error('A generic error occurred');
    default:
      return <div>No error thrown. Select an error type to see the error boundary in action.</div>;
  }
};

// Example component that demonstrates how to use the ErrorBoundary
const ErrorBoundaryExample = () => {
  const [errorType, setErrorType] = useState<string>('');
  const [key, setKey] = useState<number>(0);

  // Reset the error boundary by changing the key
  const handleReset = () => {
    setErrorType('');
    setKey((prev) => prev + 1);
  };

  // Log errors to console (in a real app, you might send to an error tracking service)
  const handleError = (error: Error) => {
    console.error('Error caught by boundary:', error);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Error Boundary Example</h1>

      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Select an error type to trigger:</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={errorType === 'fs-init' ? 'default' : 'outline'}
            onClick={() => setErrorType('fs-init')}
          >
            File System Error
          </Button>
          <Button
            variant={errorType === 'file-content' ? 'default' : 'outline'}
            onClick={() => setErrorType('file-content')}
          >
            File Content Error
          </Button>
          <Button
            variant={errorType === 'git' ? 'default' : 'outline'}
            onClick={() => setErrorType('git')}
          >
            Git Error
          </Button>
          <Button
            variant={errorType === 'partial-refresh' ? 'default' : 'outline'}
            onClick={() => setErrorType('partial-refresh')}
          >
            Partial Refresh Error
          </Button>
          <Button
            variant={errorType === 'concurrent-loading' ? 'default' : 'outline'}
            onClick={() => setErrorType('concurrent-loading')}
          >
            Concurrent Loading Error
          </Button>
          <Button
            variant={errorType === 'generic' ? 'default' : 'outline'}
            onClick={() => setErrorType('generic')}
          >
            Generic Error
          </Button>
          <Button variant="secondary" onClick={() => setErrorType('')}>
            Clear Error
          </Button>
        </div>
      </div>

      <div className="border rounded-lg p-4 bg-card min-h-[300px]">
        <ErrorBoundary key={key} onReset={handleReset} onError={handleError} showDetails={true}>
          <ErrorThrower errorType={errorType} />
        </ErrorBoundary>
      </div>

      <div className="mt-6 p-4 bg-muted rounded-lg">
        <h2 className="text-lg font-semibold mb-2">How to Use the Error Boundary</h2>
        <pre className="bg-card p-3 rounded text-sm overflow-auto">
          {`// Wrap components that might throw errors
<ErrorBoundary 
  onReset={() => {
    // Handle reset logic here
  }} 
  onError={(error, errorInfo) => {
    // Log error to an error tracking service
    logErrorToService(error, errorInfo);
  }}
  showDetails={import.meta.env.DEV}
>
  <YourComponent />
</ErrorBoundary>`}
        </pre>

        <h3 className="text-md font-semibold mt-4 mb-2">Available Props</h3>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>children:</strong> Components to render
          </li>
          <li>
            <strong>fallback:</strong> Optional custom fallback UI
          </li>
          <li>
            <strong>onReset:</strong> Optional callback when error is dismissed
          </li>
          <li>
            <strong>onError:</strong> Optional callback when error occurs
          </li>
          <li>
            <strong>showDetails:</strong> Whether to show detailed error info (defaults to true in
            development)
          </li>
        </ul>
      </div>
    </div>
  );
};

export default ErrorBoundaryExample;
