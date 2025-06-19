import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from '@brainstrike/types';
import {
  Button,
  ErrorBoundary,
  type ErrorBoundaryProps,
  type ErrorBoundaryState,
  ScrollArea,
  useToast,
} from '@brainstrike/ui';
import { isDevEnv } from '@brainstrike/utils';
import { AlertTriangle, ArrowLeft, Bug, FileWarning, RefreshCw, Server, X } from 'lucide-react';

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

  private handleCopyErrorDetails = () => {
    const { error, errorInfo } = this.state;
    if (!error) return;

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
          title: 'Success',
          description: 'Error details copied to clipboard',
        });
      })
      .catch((err) => {
        console.error('Failed to copy error details:', err);
      });
  };

  private getErrorTypeInfo() {
    const { error } = this.state;
    if (!error) return null;

    let icon = AlertTriangle;
    let color = 'text-red-500';
    let message = error.message;
    let actions = null as React.ReactNode | null;
    let displayTitle = 'Error';

    if (error instanceof FileContentError) {
      const fileError = error as InstanceType<typeof FileContentError>;
      icon = FileWarning;
      displayTitle = 'File Content Error';
      message = `Failed to load file '${fileError.path}': ${fileError.message}`;
      color = 'text-orange-500';
      actions = (
        <div className="flex gap-2 mt-2">
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
      color = 'text-purple-500';
      actions = (
        <Button onClick={this.handleReset} variant="outline" className="mt-2">
          Retry with Fewer Concurrent Operations
        </Button>
      );
    } else if (error instanceof PartialRefreshError) {
      const partialError = error as InstanceType<typeof PartialRefreshError>;
      icon = RefreshCw;
      displayTitle = 'Partial Refresh Error';
      message = `Refresh partially failed: ${partialError.successCount} succeeded, ${partialError.failCount} failed`;
      color = 'text-yellow-500';
      actions = (
        <Button onClick={this.handleReset} variant="outline" className="mt-2">
          Retry Failed Operations
        </Button>
      );
    }

    return { icon, displayTitle, message, color, actions };
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
      <div className="flex flex-col items-center justify-center h-full p-6 bg-background/95 backdrop-blur-xs">
        <div className="w-full max-w-md bg-card border rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Icon className={`h-6 w-6 mr-2 ${info?.color ?? 'text-red-500'}`} />
                <h2 className="text-xl font-bold">{info?.displayTitle ?? 'Error'}</h2>
              </div>
              <Button variant="ghost" size="icon" onClick={this.handleReset} title="Dismiss">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="p-4">
            <p className="text-destructive mb-4">{info?.message ?? error?.message}</p>
            {info?.actions}
            <div className="flex flex-wrap gap-2 mt-4">
              <Button onClick={this.handleReload} className="flex items-center">
                <RefreshCw className="mr-2 h-4 w-4" />
                Reload Page
              </Button>
              <Button onClick={this.handleReset} variant="outline" className="flex items-center">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Go Back
              </Button>
              {details && (
                <Button
                  onClick={this.toggleDetails}
                  variant="outline"
                  className="flex items-center"
                >
                  <Bug className="mr-2 h-4 w-4" />
                  {detailsVisible ? 'Hide' : 'Show'} Details
                </Button>
              )}
              {details && (
                <Button
                  onClick={this.handleCopyErrorDetails}
                  variant="outline"
                  className="flex items-center"
                >
                  Copy Details
                </Button>
              )}
            </div>
          </div>

          {detailsVisible && details && (
            <div className="p-4 border-t bg-muted/20">
              <h3 className="font-semibold mb-2">Error Details</h3>
              <ScrollArea className="bg-muted p-2 rounded text-sm font-mono max-h-60">
                <p>
                  <strong>Name:</strong> {error?.name}
                </p>
                <p>
                  <strong>Message:</strong> {error?.message}
                </p>
                {error?.stack && (
                  <div className="mt-2">
                    <strong>Stack:</strong>
                    <pre className="whitespace-pre-wrap text-xs mt-1 text-muted-foreground">
                      {error.stack}
                    </pre>
                  </div>
                )}
                {errorInfo?.componentStack && (
                  <div className="mt-2">
                    <strong>Component Stack:</strong>
                    <pre className="whitespace-pre-wrap text-xs mt-1 text-muted-foreground">
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

export default function FileExplorerErrorBoundary(props: ErrorBoundaryProps) {
  const { toast } = useToast();
  return <FileExplorerErrorBoundaryInner {...props} toast={toast} />;
}
