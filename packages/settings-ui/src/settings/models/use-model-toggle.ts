import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export interface ModelToggleController {
  /** Model ids with a write in flight; their switches disable. */
  readonly busyModelIds: ReadonlySet<string>;
  readonly toggle: (modelId: string, enabled: boolean) => void;
}

/**
 * Enabling/disabling a catalogued model, shared by the Provider Hub cards and
 * the Model Catalog list so the two surfaces cannot drift in how a write is
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
  const db = usePGliteDatabase();
  const toggleModel = useModelRegistryStore((state) => state.toggleModel);
  const { toast } = useToast();
  const [busyModelIds, setBusyModelIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  const release = useCallback((modelId: string) => {
    setBusyModelIds((current) => {
      const next = new Set(current);
      next.delete(modelId);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (modelId: string, enabled: boolean) => {
      if (!db) {
        toast({
          description: 'The model database is not ready yet. Try again in a moment.',
          title: 'Could not update model',
          variant: 'destructive',
        });
        return;
      }
      setBusyModelIds((current) => new Set(current).add(modelId));
      void toggleModel(db, modelId, enabled)
        .catch((error: unknown) => {
          toast({
            description: error instanceof Error ? error.message : 'The change was not saved.',
            title: `Could not ${enabled ? 'enable' : 'disable'} this model`,
            variant: 'destructive',
          });
        })
        .finally(() => release(modelId));
    },
    [db, release, toast, toggleModel]
  );

  return { busyModelIds, toggle };
}
