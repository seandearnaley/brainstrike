import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from '@brainstrike/types';
import {
  Button,
  ErrorBoundary,
  type ErrorBoundaryProps,
  type ErrorBoundaryState,
  ScrollArea,
  useToast,
} from '@brainstrike/ui';
import { isDevEnv } from '@brainstrike/utils/env-utils';
import { AlertTriangle, ArrowLeft, Bug, FileWarning, RefreshCw, Server, X } from 'lucide-react';
import { memo } from 'react';

/**
 * Error boundary tailored for the file explorer UI. It extends the generic
 * ErrorBoundary and adds specialized messaging and actions for common
 * file-explorer errors.
 */
interface FileExplorerErrorBoundaryProps extends ErrorBoundaryProps {
  toast: ReturnType<typeof useToast>['toast'];
}

class FileExplorerErrorBoundaryInner extends ErrorBoundary {
  declare props: FileExplorerErrorBoundaryProps;
  declare state: ErrorBoundaryState;

  private readonly handleCopyErrorDetails = () => {
    const { error, errorInfo } = this.state;
    if (!error) {
      return;
    }

    const errorDetails = `
Error: ${error.name}
Message: ${error.message}
Stack: ${error.stack || 'No stack trace available'}
Component Stack: ${errorInfo?.componentStack || 'No component stack available'}
    `.trim();

    navigator.clipboard
      .writeText(errorDetails)
      .then(() => {
        this.props.toast({
          description: 'Error details copied to clipboard',
          title: 'Success',
        });
      })
      .catch((_err) => {});
  };

  private getErrorTypeInfo() {
    const { error } = this.state;
    if (!error) {
      return null;
    }

    let icon = AlertTriangle;
    let color = 'text-destructive';
    let message = error.message;
    let actions = null as React.ReactNode | null;
    let displayTitle = 'Error';

    if (error instanceof FileContentError) {
      const fileError = error as InstanceType<typeof FileContentError>;
      icon = FileWarning;
      displayTitle = 'File Content Error';
      message = `Failed to load file '${fileError.path}': ${fileError.message}`;
      color = 'text-warning';
      actions = (
        <div className="mt-2 flex gap-2">
          <Button onClick={this.handleReset} variant="outline">
            Retry Loading
          </Button>
          <Button onClick={this.handleReload} variant="outline">
            Skip File
          </Button>
        </div>
      );
    } else if (error instanceof ConcurrentLoadingError) {
      const concurrentError = error as InstanceType<typeof ConcurrentLoadingError>;
      icon = Server;
      displayTitle = 'Loading Error';
      message = `Failed to load ${concurrentError.failedPaths.length} files: ${concurrentError.message}`;
      color = 'text-destructive';
      actions = (
        <Button className="mt-2" onClick={this.handleReset} variant="outline">
          Retry with Fewer Concurrent Operations
        </Button>
      );
    } else if (error instanceof PartialRefreshError) {
      const partialError = error as InstanceType<typeof PartialRefreshError>;
      icon = RefreshCw;
      displayTitle = 'Partial Refresh Error';
      message = `Refresh partially failed: ${partialError.successCount} succeeded, ${partialError.failCount} failed`;
      color = 'text-warning';
      actions = (
        <Button className="mt-2" onClick={this.handleReset} variant="outline">
          Retry Failed Operations
        </Button>
      );
    }

    return { actions, color, displayTitle, icon, message };
  }

  public override render() {
    const { hasError, error, errorInfo, detailsVisible } = this.state;
    const { fallback, showDetails } = this.props;
    const details = showDetails ?? isDevEnv();

    if (!hasError) {
      return this.props.children;
    }

    if (fallback) {
      return fallback;
    }

    const info = this.getErrorTypeInfo();
    const Icon = info?.icon || AlertTriangle;

    return (
      <div className="flex h-full flex-col items-center justify-center bg-background/95 p-6 backdrop-blur-xs">
        <div className="w-full max-w-md overflow-hidden rounded-lg border bg-card shadow-lg">
          <div className="border-b bg-muted/30 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Icon className={`mr-2 h-6 w-6 ${info?.color ?? 'text-destructive'}`} />
                <h2 className="font-bold text-xl">{info?.displayTitle ?? 'Error'}</h2>
              </div>
              <Button
                aria-label="Dismiss Error"
                onClick={this.handleReset}
                size="icon"
                title="Dismiss"
                variant="ghost"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="p-4">
            <p className="mb-4 text-destructive">{info?.message ?? error?.message}</p>
            {info?.actions}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button className="flex items-center" onClick={this.handleReload}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Reload Page
              </Button>
              <Button className="flex items-center" onClick={this.handleReset} variant="outline">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Go Back
              </Button>
              {details && (
                <Button
                  className="flex items-center"
                  onClick={this.toggleDetails}
                  variant="outline"
                >
                  <Bug className="mr-2 h-4 w-4" />
                  {detailsVisible ? 'Hide' : 'Show'} Details
                </Button>
              )}
              {details && (
                <Button
                  className="flex items-center"
                  onClick={this.handleCopyErrorDetails}
                  variant="outline"
                >
                  Copy Details
                </Button>
              )}
            </div>
          </div>

          {detailsVisible && details && (
            <div className="border-t bg-muted/20 p-4">
              <h3 className="mb-2 font-semibold">Error Details</h3>
              <ScrollArea className="max-h-60 rounded bg-muted p-2 font-mono text-sm">
                <p>
                  <strong>Name:</strong> {error?.name}
                </p>
                <p>
                  <strong>Message:</strong> {error?.message}
                </p>
                {error?.stack && (
                  <div className="mt-2">
                    <strong>Stack:</strong>
                    <pre className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs">
                      {error.stack}
                    </pre>
                  </div>
                )}
                {errorInfo?.componentStack && (
                  <div className="mt-2">
                    <strong>Component Stack:</strong>
                    <pre className="mt-1 whitespace-pre-wrap text-muted-foreground text-xs">
                      {errorInfo.componentStack}
                    </pre>
                  </div>
                )}
              </ScrollArea>
            </div>
          )}
        </div>
      </div>
    );
  }
}

// Set displayName for React DevTools
// biome-ignore lint/suspicious/noExplicitAny: React displayName requires any type
(FileExplorerErrorBoundaryInner as any).displayName = 'FileExplorerErrorBoundaryInner';

const FileExplorerErrorBoundary = memo(function FileExplorerErrorBoundary(
  props: ErrorBoundaryProps
) {
  const { toast } = useToast();
  return <FileExplorerErrorBoundaryInner {...props} toast={toast} />;
});

// Set displayName for the wrapper component
FileExplorerErrorBoundary.displayName = 'FileExplorerErrorBoundary';

export default FileExplorerErrorBoundary;
