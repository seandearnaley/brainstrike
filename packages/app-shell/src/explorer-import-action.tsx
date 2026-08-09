import { createLogger } from '@brainstrike/logging';
import type { QueueAdapter } from '@brainstrike/queue';
import { Button } from '@brainstrike/ui';
import { FileText } from 'lucide-react';
import { type ComponentType, type ReactElement, useEffect, useState } from 'react';
import { createRetryableLazyModuleLoader } from './retryable-lazy-module-loader';

const logger = createLogger('ExplorerImportAction');

type ExplorerImportActionModule = typeof import('@brainstrike/db-explorer/explorer-import-action');

interface LoadedExplorerImportActionProps {
  readonly embeddingQueue?: QueueAdapter | null;
}

let explorerImportActionComponent: ComponentType<LoadedExplorerImportActionProps> | null = null;

/**
 * The import flow drags in the whole db-explorer/vector-management surface, so
 * it is code-split away from the always-mounted explorer bundle and only
 * fetched once the user actually has a selection to import.
 */
const explorerImportActionLoader = createRetryableLazyModuleLoader<ExplorerImportActionModule>(
  () => import('@brainstrike/db-explorer/explorer-import-action')
);

interface ExplorerImportActionProps {
  // Callers must pass a referentially stable loader (useCallback at the app
  // root); the first resolved queue for a given loader is treated as canonical.
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
}

function ImportActionPlaceholder({ reason }: { readonly reason: string }): ReactElement {
  return (
    <Button
      aria-label="Import into collection"
      className="gap-1.5 whitespace-nowrap"
      data-testid="explorer-import-action-placeholder"
      disabled
      size="sm"
      title={reason}
      type="button"
      variant="secondary"
    >
      <FileText aria-hidden="true" className="h-4 w-4" />
      <span className="@[360px]/selection-actions:inline hidden">Import</span>
    </Button>
  );
}

/**
 * App-shell composition seam for the explorer's collection-import action.
 *
 * `@brainstrike/file-explorer-ui` cannot reach into `@brainstrike/db-explorer`
 * (db-explorer already depends on it), so the shell — which composes both —
 * owns the wiring and injects the action into the explorer's selection bar.
 */
export function ExplorerImportAction({
  loadEmbeddingQueue = null,
}: ExplorerImportActionProps): ReactElement {
  const [resolvedComponent, setResolvedComponent] =
    useState<ComponentType<LoadedExplorerImportActionProps> | null>(
      () => explorerImportActionComponent
    );
  const [embeddingQueue, setEmbeddingQueue] = useState<QueueAdapter | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (resolvedComponent && (embeddingQueue || !loadEmbeddingQueue)) {
      return;
    }

    let cancelled = false;
    const modulePromise = resolvedComponent
      ? Promise.resolve(null)
      : explorerImportActionLoader.load().then((module) => {
          explorerImportActionComponent = module.ExplorerImportAction;
          return module.ExplorerImportAction;
        });
    const queuePromise =
      embeddingQueue || !loadEmbeddingQueue ? Promise.resolve(null) : loadEmbeddingQueue();

    void Promise.all([modulePromise, queuePromise])
      .then(([resolvedAction, resolvedQueue]) => {
        if (cancelled) {
          return;
        }
        if (resolvedAction) {
          setResolvedComponent(() => resolvedAction);
        }
        if (resolvedQueue) {
          setEmbeddingQueue(resolvedQueue);
        }
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const failure = error instanceof Error ? error : new Error('Failed to load import tools.');
        logger.error('Failed to prepare the explorer import action', { error: failure });
        setLoadError(failure);
      });

    return () => {
      cancelled = true;
    };
  }, [embeddingQueue, loadEmbeddingQueue, resolvedComponent]);

  if (loadError) {
    return <ImportActionPlaceholder reason={`Import unavailable: ${loadError.message}`} />;
  }

  const queueReady = !loadEmbeddingQueue || embeddingQueue !== null;
  if (!(resolvedComponent && queueReady)) {
    return <ImportActionPlaceholder reason="Preparing import tools…" />;
  }

  const ResolvedComponent = resolvedComponent;
  return <ResolvedComponent embeddingQueue={embeddingQueue} />;
}

ExplorerImportAction.displayName = 'ExplorerImportAction';
