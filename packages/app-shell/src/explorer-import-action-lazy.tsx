import { Button, SELECTION_ACTION_BAR_COMPACT_LABEL_CLASS } from '@brainstrike/ui';
import { FileText } from 'lucide-react';
import type { ComponentType, ReactElement } from 'react';
import { createRetryableLazyModuleLoader } from './retryable-lazy-module-loader';
import { useLazyComponent } from './use-lazy-component';

type ExplorerImportActionModule = typeof import('@brainstrike/db-explorer/explorer-import-action');

let explorerImportActionComponent: ComponentType | null = null;

/**
 * The import flow drags in the whole db-explorer/vector-management surface, so
 * it is code-split away from the always-mounted explorer bundle and only
 * fetched once the user actually has a selection to import.
 */
const explorerImportActionLoader = createRetryableLazyModuleLoader<ExplorerImportActionModule>(
  () => import('@brainstrike/db-explorer/explorer-import-action')
);

function loadExplorerImportAction(): Promise<ComponentType> {
  return explorerImportActionLoader.load().then((module) => {
    explorerImportActionComponent = module.ExplorerImportAction;
    return module.ExplorerImportAction;
  });
}

/**
 * Stands in for the real action while it loads, or after it failed to.
 *
 * With `onRetry` the button becomes live: a load failure keeps its reason
 * visible in the tooltip but stops being terminal, so a transient load
 * rejection no longer disables importing for the rest of the session.
 */
function ImportActionPlaceholder({
  onRetry,
  reason,
}: {
  readonly onRetry?: (() => void) | undefined;
  readonly reason: string;
}): ReactElement {
  return (
    <Button
      aria-label={onRetry ? `Retry loading import tools. ${reason}` : 'Import into collection'}
      className="gap-1.5 whitespace-nowrap"
      data-testid={onRetry ? 'explorer-import-action-retry' : 'explorer-import-action-placeholder'}
      disabled={!onRetry}
      onClick={onRetry}
      size="sm"
      title={reason}
      type="button"
      variant="secondary"
    >
      <FileText aria-hidden="true" className="h-4 w-4" />
      <span className={SELECTION_ACTION_BAR_COMPACT_LABEL_CLASS}>
        {onRetry ? 'Retry' : 'Import'}
      </span>
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
export function ExplorerImportActionLazy(): ReactElement {
  const { component, loadError, ready, retry } = useLazyComponent({
    initialComponent: explorerImportActionComponent,
    label: 'explorer import action',
    load: loadExplorerImportAction,
  });

  if (loadError) {
    return (
      <ImportActionPlaceholder
        onRetry={retry}
        reason={`Import unavailable: ${loadError.message}`}
      />
    );
  }

  if (!(ready && component)) {
    return <ImportActionPlaceholder reason="Preparing import tools…" />;
  }

  const ResolvedAction = component;
  return <ResolvedAction />;
}

ExplorerImportActionLazy.displayName = 'ExplorerImportActionLazy';
