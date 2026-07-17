import { Button } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { Component, type ReactNode } from 'react';

const logger = createLogger('MarkdownPreview');

interface Props {
  readonly children: ReactNode;
  readonly onOpenSource: () => void;
}
interface State {
  readonly error: string | null;
}

/** A pathological markdown document must never white-screen the tab. The
 * fallback names the failure and offers the always-working source view. */
export class MarkdownPreviewErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    logger.error('Markdown preview crashed', { error });
  }

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="font-semibold">Preview failed to render</p>
        <p className="max-w-md text-muted-foreground text-sm">{this.state.error}</p>
        <Button onClick={this.props.onOpenSource} size="sm" variant="outline">
          Open in source
        </Button>
      </div>
    );
  }
}
