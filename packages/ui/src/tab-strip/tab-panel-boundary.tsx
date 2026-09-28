import { createLogger } from '@brainstrike/logging';
import { AlertTriangle, Copy, RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, Fragment, type ReactElement, type ReactNode } from 'react';
import { Button } from '../button';
import { isChunkLoadError, useAppReloadState, useRequestAppReload } from '../chunk-load';
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
    const layout = this.props.layout ?? 'panel';
    // Remounting cannot recover a failed chunk: React.lazy caches the rejection.
    if (isChunkLoadError(error)) {
      return (
        <ChunkLoadFallback
          componentStack={componentStack}
          error={error}
          label={this.props.label}
          layout={layout}
        />
      );
    }
    return (
      <TabPanelFallback
        componentStack={componentStack}
        error={error}
        label={this.props.label}
        layout={layout}
        onReload={this.reload}
      />
    );
  }
}

// Capability gate: a missing clipboard hides the button, never a dead one.
function canCopyCrashDetails(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
}

function copyCrashDetails(label: string, error: Error, componentStack: string | null): void {
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
  const canCopy = canCopyCrashDetails();
  const copyDetails = (): void => copyCrashDetails(label, error, componentStack);

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

/**
 * Fallback for a panel whose lazy chunk failed to download. "Reload app" is the
 * only recovery, so there is no "Reload tab"; once a reload already failed to
 * help, the primary action becomes reporting the problem.
 */
function ChunkLoadFallback({
  componentStack,
  error,
  label,
  layout,
}: {
  readonly componentStack: string | null;
  readonly error: Error;
  readonly label: string;
  readonly layout: 'inline' | 'panel';
}): ReactElement {
  const { reloadAlreadyAttempted } = useAppReloadState();
  const requestAppReload = useRequestAppReload();
  const title = reloadAlreadyAttempted ? `${label} still can't load` : `${label} couldn't load`;

  if (layout === 'inline') {
    return (
      <div
        className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-muted-foreground text-xs"
        data-layout="inline"
        data-slot="tab-panel-boundary"
        role="alert"
      >
        <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 truncate">{title}</span>
        <Button onClick={() => requestAppReload()} size="xs" type="button" variant="ghost">
          <RotateCw aria-hidden="true" />
          Reload app
        </Button>
      </div>
    );
  }

  const reloadButton = (
    <Button
      onClick={() => requestAppReload()}
      size="sm"
      type="button"
      variant={reloadAlreadyAttempted ? 'outline' : 'default'}
    >
      <RotateCw aria-hidden="true" />
      Reload app
    </Button>
  );
  const copyButton = canCopyCrashDetails() ? (
    <Button
      onClick={() => copyCrashDetails(label, error, componentStack)}
      size="sm"
      type="button"
      variant={reloadAlreadyAttempted ? 'default' : 'outline'}
    >
      <Copy aria-hidden="true" />
      Copy details
    </Button>
  ) : null;
  const [primary, secondary] = reloadAlreadyAttempted
    ? [copyButton, reloadButton]
    : [reloadButton, copyButton];

  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center"
      data-layout="panel"
      data-slot="tab-panel-boundary"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="size-5 text-destructive" />
      <p className="font-medium text-sm">{title}</p>
      <p className="max-w-sm break-words text-muted-foreground text-xs">
        {reloadAlreadyAttempted
          ? "Reloading didn't fix this. Copy the details and report the problem."
          : 'Part of BrainStrike failed to download, usually after an update or a dropped connection. Reload the app to fix it.'}
      </p>
      <div className="flex items-center gap-2">
        {primary}
        {secondary}
      </div>
    </div>
  );
}
