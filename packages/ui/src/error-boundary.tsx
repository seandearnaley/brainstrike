import { Button, ScrollArea } from '@brainstrike/ui';
import { isDevEnv } from '@brainstrike/utils';
import { AlertTriangle, ArrowLeft, Bug, RefreshCw, X } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  showDetails?: boolean;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  detailsVisible: boolean;
}

/**
 * Generic ErrorBoundary component that provides basic error handling.
 * It displays a fallback UI when an error occurs and allows the user
 * to reload the page or reset the boundary. Error details can be
 * toggled for development purposes.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
    detailsVisible: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('Uncaught error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  protected handleReload = () => {
    window.location.reload();
  };

  protected handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      detailsVisible: false,
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
      <div className="flex flex-col items-center justify-center h-full p-6 bg-background/95 backdrop-blur-xs">
        <div className="w-full max-w-md bg-card border rounded-lg shadow-lg overflow-hidden">
          <div className="p-4 border-b bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <AlertTriangle className="h-6 w-6 mr-2 text-red-500" />
                <h2 className="text-xl font-bold">Error</h2>
              </div>
              <Button variant="ghost" size="icon" onClick={this.handleReset} title="Dismiss">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="p-4">
            <p className="text-destructive mb-4">{error?.message ?? 'Something went wrong.'}</p>
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

export default ErrorBoundary;
