import type { QueueAdapter } from '@brainstrike/queue';
import { type ComponentType, type ReactElement, useEffect, useState } from 'react';

type DatabaseTabChunkModule = typeof import('./database-tab-chunk');

let databaseTabModulePromise: Promise<DatabaseTabChunkModule> | null = null;
let databaseTabChunkComponent: ComponentType<DatabaseTabProps> | null = null;

function loadDatabaseTabModule(): Promise<DatabaseTabChunkModule> {
  if (databaseTabModulePromise) {
    return databaseTabModulePromise;
  }
  databaseTabModulePromise = import('./database-tab-chunk').then((module) => {
    databaseTabChunkComponent = module.DatabaseTab;
    return module;
  });
  return databaseTabModulePromise;
}

export function preloadDatabaseTab(): Promise<void> {
  return loadDatabaseTabModule().then(() => undefined);
}

interface DatabaseTabProps {
  readonly embeddingQueue?: QueueAdapter | null;
}

export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): ReactElement {
  const [resolvedComponent, setResolvedComponent] =
    useState<ComponentType<DatabaseTabProps> | null>(() => databaseTabChunkComponent);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (resolvedComponent) {
      return;
    }

    let cancelled = false;
    void loadDatabaseTabModule()
      .then((module) => {
        if (!cancelled) {
          setResolvedComponent(() => module.DatabaseTab);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error : new Error('Failed to load the database tab chunk.')
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedComponent]);

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
  return <ResolvedComponent embeddingQueue={embeddingQueue} />;
}
