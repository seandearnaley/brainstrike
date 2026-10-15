import { createLogger } from '@brainstrike/logging';
import { Component, type ErrorInfo, type ReactNode } from 'react';

const logger = createLogger('BackgroundHostErrorBoundary');

interface BackgroundHostErrorBoundaryProps {
  readonly children: ReactNode;
  readonly host: 'chunking-host' | 'embedding-host';
}

interface BackgroundHostErrorBoundaryState {
  readonly hasError: boolean;
}

export class BackgroundHostErrorBoundary extends Component<
  BackgroundHostErrorBoundaryProps,
  BackgroundHostErrorBoundaryState
> {
  override state: BackgroundHostErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): BackgroundHostErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error('Background host renderer crashed during render', {
      componentStack: errorInfo.componentStack,
      error,
      host: this.props.host,
    });
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}
