import type { QueueAdapter } from '@brainstrike/queue';
import { Button } from '@brainstrike/ui';
import { FileText } from 'lucide-react';
import type { ComponentType, ReactElement } from 'react';
import { createRetryableLazyModuleLoader } from './retryable-lazy-module-loader';
import { useLazyComponentWithEmbeddingQueue } from './use-lazy-component-with-embedding-queue';

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

function loadExplorerImportAction(): Promise<ComponentType<LoadedExplorerImportActionProps>> {
  return explorerImportActionLoader.load().then((module) => {
    explorerImportActionComponent = module.ExplorerImportAction;
    return module.ExplorerImportAction;
  });
}

interface ExplorerImportActionLazyProps {
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
 *
 * Named `…Lazy` to stay distinguishable from the db-explorer component it
 * loads, which is the real `ExplorerImportAction`.
 */
export function ExplorerImportActionLazy({
  loadEmbeddingQueue = null,
}: ExplorerImportActionLazyProps): ReactElement {
  const { component, embeddingQueue, loadError, ready } =
    useLazyComponentWithEmbeddingQueue<LoadedExplorerImportActionProps>({
      initialComponent: explorerImportActionComponent,
      label: 'explorer import action',
      load: loadExplorerImportAction,
      loadEmbeddingQueue,
    });

  if (loadError) {
    return <ImportActionPlaceholder reason={`Import unavailable: ${loadError.message}`} />;
  }

  if (!(ready && component)) {
    return <ImportActionPlaceholder reason="Preparing import tools…" />;
  }

  const ResolvedAction = component;
  return <ResolvedAction embeddingQueue={embeddingQueue} />;
}

ExplorerImportActionLazy.displayName = 'ExplorerImportActionLazy';
