import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { AlertTriangle, ArrowLeft, Bug, FileWarning, RefreshCw, Server, X } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { cn, isDevEnv } from './lib/utils';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  showDetails?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  isDetailsVisible: boolean;
}

/**
 * Enhanced ErrorBoundary component that provides specialized error handling
 * for different error types and offers appropriate recovery options.
 */
class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    isDetailsVisible: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('Uncaught error:', error, errorInfo);

    // Call onError callback if provided
    this.props.onError?.(error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      isDetailsVisible: false,
    });

    // Call onReset callback if provided
    this.props.onReset?.();
  };

  private handleToggleDetails = () => {
    this.setState((prevState) => ({
      isDetailsVisible: !prevState.isDetailsVisible,
    }));
  };

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
        alert('Error details copied to clipboard');
      })
      .catch((err) => {
        console.error('Failed to copy error details:', err);
      });
  };

  private getErrorTypeInfo() {
    const { error } = this.state;
    if (!error) return null;

    // Default error info
    let icon = AlertTriangle;
    const title = 'Error';
    let color = 'text-red-500';
    let message = error.message;
    let actions = null;

    // Custom title for display that's separate from the default error title
    let displayTitle = 'Error';

    // Specialized handling based on error type
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

    return { icon, title, displayTitle, message, color, actions };
  }

  public override render() {
    const { hasError, error, errorInfo, isDetailsVisible } = this.state;
    const { fallback, showDetails } = this.props;
    const details = showDetails !== undefined ? showDetails : isDevEnv();

    if (!hasError) {
      return this.props.children;
    }

    if (fallback) {
      return fallback;
    }

    const errorTypeInfo = this.getErrorTypeInfo();
    const Icon = errorTypeInfo?.icon || AlertTriangle;

    return (
      <div className="flex flex-col items-center justify-center h-full p-6 bg-background/95 backdrop-blur-xs">
        <div className="w-full max-w-md bg-card border rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Icon className={cn('h-6 w-6 mr-2', errorTypeInfo?.color)} />
                <h2 className="text-xl font-bold">{errorTypeInfo?.displayTitle || 'Error'}</h2>
              </div>
              <Button variant="ghost" size="icon" onClick={this.handleReset} title="Dismiss">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="p-4">
            <p className="text-destructive mb-4">{errorTypeInfo?.message || error?.message}</p>

            {/* Custom actions based on error type */}
            {errorTypeInfo?.actions}

            {/* Default actions */}
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
                  onClick={this.handleToggleDetails}
                  variant="outline"
                  className="flex items-center"
                >
                  <Bug className="mr-2 h-4 w-4" />
                  {isDetailsVisible ? 'Hide' : 'Show'} Details
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

          {/* Error details (for development) */}
          {isDetailsVisible && details && (
            <div className="p-4 border-t bg-muted/20">
              <h3 className="font-semibold mb-2">Error Details</h3>
              <div className="bg-muted p-2 rounded text-sm font-mono overflow-auto max-h-60">
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
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
