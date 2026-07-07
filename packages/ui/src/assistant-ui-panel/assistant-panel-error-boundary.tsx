import { createLogger } from '@brainstrike/utils/logger';
import { Component, type ErrorInfo, type ReactNode } from 'react';

const logger = createLogger('AssistantPanelErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: (reset: () => void, error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

export class AssistantPanelErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('Assistant panel render error', {
      componentStack: info.componentStack,
      error: error.message,
    });
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(this.reset, error);
      }
      return (
        <div className="flex flex-col items-start gap-2 p-4 text-sm" role="alert">
          <p>The assistant panel hit an error and stopped rendering.</p>
          <button
            className="rounded-md border border-border px-3 py-1"
            onClick={this.reset}
            type="button"
          >
            Reset panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
