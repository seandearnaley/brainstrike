import { createLogger } from '@brainstrike/logging';
import { AlertTriangle, Copy, RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, Fragment, type ReactElement, type ReactNode } from 'react';
import { Button } from '../button';
import { toast } from '../use-toast';

const logger = createLogger('TabPanelBoundary');

export interface TabPanelBoundaryProps {
  readonly children: ReactNode;
  /** Human name of what the boundary guards: "Changes", "Tabs". */
  readonly label: string;
  /** `panel` fills a tab panel; `inline` fits one 36px strip row. */
  readonly layout?: 'inline' | 'panel' | undefined;
  /** Changing it (e.g. the tab id) clears a caught error and remounts the subtree. */
  readonly resetKey?: string | undefined;
}

interface TabPanelBoundaryState {
  readonly componentStack: string | null;
  readonly error: Error | null;
  readonly generation: number;
}

function formatCrashDetails(label: string, error: Error, componentStack: string | null): string {
  return [`${label}: ${error.name}: ${error.message}`, error.stack ?? '', componentStack ?? '']
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * Per-panel error boundary (BST-1836 §7.3). A render crash in one tab panel is
 * contained to that panel, so siblings and the strip stay interactive, instead
 * of unmounting the React root. Class-only because React has no hook
 * equivalent. Event-handler and async errors are NOT caught here; they surface
 * through ActionOutcome toasts and logs.
 */
export class TabPanelBoundary extends Component<TabPanelBoundaryProps, TabPanelBoundaryState> {
  override state: TabPanelBoundaryState = { componentStack: null, error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<TabPanelBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error(
      'Tab panel crashed',
      { componentStack: info.componentStack, label: this.props.label },
      error
    );
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override componentDidUpdate(previous: TabPanelBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.reload();
    }
  }

  private readonly reload = (): void => {
    this.setState((current) => ({
      componentStack: null,
      error: null,
      generation: current.generation + 1,
    }));
  };

  override render(): ReactNode {
    const { componentStack, error, generation } = this.state;
    if (error === null) {
      return <Fragment key={generation}>{this.props.children}</Fragment>;
    }
    return (
      <TabPanelFallback
        componentStack={componentStack}
        error={error}
        label={this.props.label}
        layout={this.props.layout ?? 'panel'}
        onReload={this.reload}
      />
    );
  }
}

function TabPanelFallback({
  componentStack,
  error,
  label,
  layout,
  onReload,
}: {
  readonly componentStack: string | null;
  readonly error: Error;
  readonly label: string;
  readonly layout: 'inline' | 'panel';
  readonly onReload: () => void;
}): ReactElement {
  // Capability gate: a missing clipboard hides the button, never a dead one.
  const canCopy =
    typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
  const copyDetails = (): void => {
    navigator.clipboard.writeText(formatCrashDetails(label, error, componentStack)).then(
      () => toast({ description: 'Crash details copied' }),
      (copyError: unknown) => {
        logger.error('Copying tab crash details failed', { label }, copyError);
        toast({
          description: 'Could not copy crash details',
          title: 'Copy failed',
          variant: 'destructive',
        });
      }
    );
  };

  if (layout === 'inline') {
    return (
      <div
        className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-muted-foreground text-xs"
        data-layout="inline"
        data-slot="tab-panel-boundary"
        role="alert"
      >
        <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 truncate">{label} unavailable</span>
        <Button onClick={onReload} size="xs" type="button" variant="ghost">
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center"
      data-layout="panel"
      data-slot="tab-panel-boundary"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="size-5 text-destructive" />
      <p className="font-medium text-sm">{label} stopped working</p>
      <p className="max-w-sm break-words text-muted-foreground text-xs">{error.message}</p>
      <div className="flex items-center gap-2">
        <Button onClick={onReload} size="sm" type="button" variant="outline">
          <RotateCw aria-hidden="true" />
          Reload tab
        </Button>
        {canCopy ? (
          <Button onClick={copyDetails} size="sm" type="button" variant="ghost">
            <Copy aria-hidden="true" />
            Copy details
          </Button>
        ) : null}
      </div>
    </div>
  );
}
