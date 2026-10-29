import {
  useEnsureModelRegistry,
  useModelRegistrySource,
} from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { Button, cn, useToast } from '@brainstrike/ui';
import { RefreshCw } from 'lucide-react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ModelCatalog } from './model-catalog';
import { type ModelBulkChange, useModelBulkToggle } from './use-model-bulk-toggle';
import { DATABASE_NOT_READY, useModelToggle } from './use-model-toggle';

/**
 * Refetch the registry. A missing database is surfaced as a destructive toast
 * (the `useModelToggle` contract), never a silent no-op.
 */
function useRegistryRefresh(): () => void {
  const db = useModelRegistrySource();
  const fetchRegistry = useModelRegistryStore((state) => state.fetchRegistry);
  const { toast } = useToast();
  return useCallback((): void => {
    if (!db) {
      toast({
        description: DATABASE_NOT_READY,
        title: 'Could not refresh the model registry',
        variant: 'destructive',
      });
      return;
    }
    void fetchRegistry(db);
  }, [db, fetchRegistry, toast]);
}

/** Model Catalog category header controls: registry refresh. */
export function ModelCatalogHeaderActions() {
  const isLoading = useModelRegistryStore((state) => state.isLoading);
  const refresh = useRegistryRefresh();
  return (
    <div className="flex items-center gap-2">
      <Button
        aria-label="Refresh model registry"
        data-testid="model-registry-refresh"
        disabled={isLoading}
        onClick={refresh}
        size="icon-sm"
        title="Refresh model registry"
        variant="outline"
      >
        <RefreshCw
          className={cn('size-4', isLoading && 'animate-spin motion-reduce:animate-none')}
        />
      </Button>
    </div>
  );
}

export function ModelSelectionPage() {
  const { error, hasLoaded, models, providers } = useModelRegistryStore(
    useShallow((state) => ({
      error: state.error,
      hasLoaded: state.hasLoaded,
      models: state.models,
      providers: state.providers,
    }))
  );
  // Shared with the Provider Hub cards: one implementation of "enable this
  // model", so a failure is reported the same way on both surfaces. Bulk
  // changes go through the same controller (one busy set, one failure path).
  const { busyModelIds, toggle, toggleMany } = useModelToggle();
  const applyBulkChange = useModelBulkToggle({ busyModelIds, toggleMany });

  useEnsureModelRegistry();

  const handleToggle = useCallback(
    (modelId: string, enabled: boolean): void => {
      void toggle(modelId, enabled);
    },
    [toggle]
  );

  const handleBulkChange = useCallback(
    (change: ModelBulkChange): void => {
      void applyBulkChange(change);
    },
    [applyBulkChange]
  );

  const handleRefresh = useRegistryRefresh();

  if (error) {
    return (
      <div
        className="bg-destructive/10 text-destructive rounded-md p-4"
        data-testid="model-registry-error"
      >
        <p className="font-medium">Error loading models</p>
        <p className="text-sm">{error}</p>
        <Button
          className="mt-2"
          data-testid="model-registry-retry"
          onClick={handleRefresh}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <ModelCatalog
      busyModelIds={busyModelIds}
      loaded={hasLoaded}
      models={models}
      onBulkChange={handleBulkChange}
      onRefresh={handleRefresh}
      onToggle={handleToggle}
      providers={providers}
    />
  );
}
