import type { QueueAdapter } from '@brainstrike/queue';
import { type ComponentType, type ReactElement, useEffect, useState } from 'react';
import { createRetryableLazyModuleLoader } from './retryable-lazy-module-loader';

type DatabaseTabChunkModule = typeof import('./database-tab-chunk');

interface LoadedDatabaseTabProps {
  readonly chunkingMode?: 'host-proxy' | 'local';
  readonly embeddingQueue?: QueueAdapter | null;
}

let databaseTabChunkComponent: ComponentType<LoadedDatabaseTabProps> | null = null;
const databaseTabModuleLoader = createRetryableLazyModuleLoader<DatabaseTabChunkModule>(
  () => import('./database-tab-chunk')
);

function loadDatabaseTabModule(): Promise<DatabaseTabChunkModule> {
  return databaseTabModuleLoader.load().then((module) => {
    databaseTabChunkComponent = module.DatabaseTab;
    return module;
  });
}

export function preloadDatabaseTab(): Promise<void> {
  return loadDatabaseTabModule().then(() => undefined);
}

interface DatabaseTabProps {
  readonly chunkingMode?: 'host-proxy' | 'local';
  // Callers must pass a referentially stable loader (useCallback at the app root).
  // This component treats the first resolved queue for a given loader as canonical
  // and does not silently swap queue instances during unrelated parent re-renders.
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
}

export function DatabaseTab({
  chunkingMode = 'local',
  loadEmbeddingQueue = null,
}: DatabaseTabProps): ReactElement {
  const [resolvedComponent, setResolvedComponent] =
    useState<ComponentType<LoadedDatabaseTabProps> | null>(() => databaseTabChunkComponent);
  const [embeddingQueue, setEmbeddingQueue] = useState<QueueAdapter | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (resolvedComponent && (embeddingQueue || !loadEmbeddingQueue)) {
      return;
    }

    let cancelled = false;
    const modulePromise = resolvedComponent
      ? Promise.resolve(null)
      : loadDatabaseTabModule().then((module) => module.DatabaseTab);
    const queuePromise =
      embeddingQueue || !loadEmbeddingQueue ? Promise.resolve(null) : loadEmbeddingQueue();

    void Promise.all([modulePromise, queuePromise])
      .then(([resolvedDatabaseTab, resolvedQueue]) => {
        if (!cancelled) {
          if (resolvedDatabaseTab) {
            setResolvedComponent(() => resolvedDatabaseTab);
          }
          if (resolvedQueue) {
            setEmbeddingQueue(resolvedQueue);
          }
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error : new Error('Failed to load database tools.')
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [embeddingQueue, loadEmbeddingQueue, resolvedComponent]);

  const queueReady = !loadEmbeddingQueue || embeddingQueue !== null;
  const ready = resolvedComponent !== null && queueReady;

  let content: ReactElement;
  if (loadError) {
    content = (
      <div
        className="flex h-full min-h-0 flex-1 items-center justify-center p-4 text-destructive text-sm"
        data-testid="database-tab-load-error"
        role="alert"
      >
        Failed to load database tools: {loadError.message}
      </div>
    );
  } else if (ready) {
    const ResolvedComponent = resolvedComponent;
    content = <ResolvedComponent chunkingMode={chunkingMode} embeddingQueue={embeddingQueue} />;
  } else {
    content = <DatabaseTabLoadingState />;
  }

  return (
    <div
      aria-busy={!(loadError || ready)}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel-surface [contain:layout_paint_style]"
      data-testid="database-tab-frame"
    >
      {content}
    </div>
  );
}

function DatabaseTabLoadingState(): ReactElement {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel-surface"
      data-testid="database-tab-loading"
      role="status"
    >
      <div
        className="flex min-h-0 flex-[38] flex-col overflow-hidden"
        data-testid="database-tab-loading-top-panel"
      >
        <div
          className="@container/database-toolbar h-9 shrink-0 border-b bg-background"
          data-testid="database-tab-loading-toolbar"
        >
          <div className="flex h-full items-center justify-between @[360px]:gap-2 gap-1 @[360px]:px-4 px-2">
            <div aria-hidden="true" className="h-7 @[360px]:w-14 w-7 rounded-md bg-muted/55" />
            <div aria-hidden="true" className="flex @[360px]:gap-2 gap-1">
              <div className="size-7 rounded-md bg-muted/55" />
              <div className="size-7 rounded-md bg-muted/55" />
              <div
                className="h-7 @[360px]:w-20 w-7 rounded-md bg-muted/55"
                data-testid="database-tab-loading-settings"
              />
            </div>
          </div>
          <span className="sr-only">Loading database tools…</span>
        </div>
        <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
          <div className="h-8 w-full rounded-md bg-muted/45" />
          <div className="h-7 w-2/3 rounded-md bg-muted/35" />
        </div>
        <div
          aria-hidden="true"
          className="flex h-9 shrink-0 items-center justify-center gap-2 border-t bg-background px-2"
          data-testid="database-tab-loading-actions"
        >
          <div className="h-7 w-10 rounded-md bg-muted/50" />
          <div className="size-7 rounded-md bg-muted/50" />
          <div className="h-7 w-14 rounded-md bg-muted/50" />
        </div>
      </div>
      <div aria-hidden="true" className="h-1 shrink-0 bg-border" />
      <div aria-hidden="true" className="min-h-0 flex-[62] border-t bg-background/35 p-4">
        <div className="h-full rounded-md border border-border/60 bg-muted/15" />
      </div>
    </div>
  );
}
