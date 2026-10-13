import { useModelRegistrySource } from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
export const DATABASE_NOT_READY = 'The model database is not ready yet. Try again in a moment.';

/** A bulk write's result. `previous` holds each id's enabled state before the write, for Undo. */
export type ModelBulkToggleOutcome =
  | { readonly committed: false }
  | { readonly committed: true; readonly previous: ReadonlyMap<string, boolean> };

export interface ModelToggleController {
  /** Model ids with a write in flight; their switches disable. */
  readonly busyModelIds: ReadonlySet<string>;
  /**
   * Resolves `true` once the write commits and `false` after a destructive
   * toast. It never rejects, so a caller can act on success without a second
   * error path.
   */
  readonly toggle: (modelId: string, enabled: boolean) => Promise<boolean>;
  /**
   * One database write for many models (BST-1805), with `toggle`'s contract:
   * every id is busy while the write is in flight, a failure raises a
   * destructive toast, and the promise never rejects.
   */
  readonly toggleMany: (
    modelIds: readonly string[],
    enabled: boolean
  ) => Promise<ModelBulkToggleOutcome>;
}

function describeModels(count: number): string {
  return count === 1 ? 'this model' : `${count} models`;
}

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : 'The change was not saved.';
}

/**
 * Enabling/disabling catalogued models, shared by the Provider Hub cards and
 * the Model Catalog so the two surfaces cannot drift in how a write is
 * attempted, reported, or refused (BST-1358 review).
 *
 * NO SILENT FALLBACKS on either arm:
 *
 * - A missing database is surfaced, not ignored. Both surfaces previously
 *   returned early when `db` was null, so the switch snapped back with no
 *   explanation.
 * - A rejected write is surfaced too. Both surfaces previously dropped the
 *   rejection, leaving the UI showing a state the database never accepted.
 */
export function useModelToggle(): ModelToggleController {
  const db = useModelRegistrySource();
  const toggleModel = useModelRegistryStore((state) => state.toggleModel);
  const setModelsEnabled = useModelRegistryStore((state) => state.setModelsEnabled);
  const { toast } = useToast();
  const [busyModelIds, setBusyModelIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  const markBusy = useCallback((modelIds: readonly string[], busy: boolean): void => {
    setBusyModelIds((current) => {
      const next = new Set(current);
      for (const id of modelIds) {
        if (busy) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  }, []);

  const toggle = useCallback(
    async (modelId: string, enabled: boolean): Promise<boolean> => {
      if (!db) {
        toast({
          description: DATABASE_NOT_READY,
          title: 'Could not update model',
          variant: 'destructive',
        });
        return false;
      }
      markBusy([modelId], true);
      try {
        await toggleModel(db, modelId, enabled);
        return true;
      } catch (error: unknown) {
        toast({
          description: errorDescription(error),
          title: `Could not ${enabled ? 'enable' : 'disable'} this model`,
          variant: 'destructive',
        });
        return false;
      } finally {
        markBusy([modelId], false);
      }
    },
    [db, markBusy, toast, toggleModel]
  );

  const toggleMany = useCallback(
    async (modelIds: readonly string[], enabled: boolean): Promise<ModelBulkToggleOutcome> => {
      if (!db) {
        toast({
          description: DATABASE_NOT_READY,
          title: 'Could not update models',
          variant: 'destructive',
        });
        return { committed: false };
      }
      markBusy(modelIds, true);
      try {
        const previous = await setModelsEnabled(db, modelIds, enabled);
        return { committed: true, previous };
      } catch (error: unknown) {
        toast({
          description: errorDescription(error),
          title: `Could not ${enabled ? 'enable' : 'disable'} ${describeModels(modelIds.length)}`,
          variant: 'destructive',
        });
        return { committed: false };
      } finally {
        markBusy(modelIds, false);
      }
    },
    [db, markBusy, setModelsEnabled, toast]
  );

  return { busyModelIds, toggle, toggleMany };
}
