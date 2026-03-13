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

  if (loadError) {
    throw loadError;
  }

  if (!resolvedComponent) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm"
        data-testid="database-tab-loading"
      >
        Loading database tools...
      </div>
    );
  }

  const ResolvedComponent = resolvedComponent;
  return <ResolvedComponent chunkingMode={chunkingMode} embeddingQueue={embeddingQueue} />;
}
