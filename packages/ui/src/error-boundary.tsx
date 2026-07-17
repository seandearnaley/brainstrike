import { Button, ScrollArea } from '@brainstrike/ui';
import { isDevEnv } from '@brainstrike/utils/env-utils';
import { AlertTriangle, ArrowLeft, Bug, RefreshCw, X } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  showDetails?: boolean;
}

export interface ErrorBoundaryState {
  detailsVisible: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  hasError: boolean;
}

/**
 * Generic ErrorBoundary component that provides basic error handling.
 * It displays a fallback UI when an error occurs and allows the user
 * to reload the page or reset the boundary. Error details can be
 * toggled for development purposes.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {
    detailsVisible: false,
    error: null,
    errorInfo: null,
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, hasError: true };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    this.props.onError?.(error, errorInfo);
  }

  protected handleReload = async () => {
    const currentWindow = window as unknown as Window & {
      desktopLifecycle?: { noteReloadIntent: (reason: string) => Promise<void> };
    };
    await currentWindow.desktopLifecycle?.noteReloadIntent('error-boundary-reload');
    window.location.reload();
  };

  protected handleReset = () => {
    this.setState({
      detailsVisible: false,
      error: null,
      errorInfo: null,
      hasError: false,
    });
    this.props.onReset?.();
  };

  protected toggleDetails = () => {
    this.setState((prev) => ({ detailsVisible: !prev.detailsVisible }));
  };

  public override render() {
    const { hasError, error, errorInfo, detailsVisible } = this.state;
    const { children, fallback, showDetails } = this.props;
    const details = showDetails ?? isDevEnv();

    if (!hasError) {
      return children;
    }

    if (fallback) {
      return fallback;
    }

    return (
      <div className="flex h-full flex-col items-center justify-center bg-background/95 p-6 backdrop-blur-xs">
        <div className="w-full max-w-md overflow-hidden rounded-lg border bg-card shadow-lg">
          <div className="border-b bg-muted/30 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <AlertTriangle className="mr-2 h-6 w-6 text-red-500" />
                <h2 className="font-bold text-xl">Error</h2>
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
            <p className="mb-4 text-destructive">{error?.message ?? 'Something went wrong.'}</p>
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

export default ErrorBoundary;
