import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { ToastAction, useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useRef } from 'react';
import { pluralize, pluralNoun } from './catalog-format';
import type { ModelToggleController } from './use-model-toggle';

export interface ModelBulkChange {
  readonly enabled: boolean;
  /** Only the ids whose state actually changes (the caller filters). */
  readonly modelIds: readonly string[];
  /** Who the change is about: "OpenRouter" → "Disabled 59 OpenRouter models". */
  readonly scopeLabel: string;
}

/**
 * The ids Undo may still restore: those whose CURRENT state is still the bulk
 * target (a later single-row toggle wins) and that have no write in flight.
 */
function restorableEntries(
  previous: ReadonlyMap<string, boolean>,
  target: boolean,
  busyModelIds: ReadonlySet<string>
): Map<string, boolean> {
  const current = new Map(
    useModelRegistryStore.getState().models.map((model) => [model.id, model.isEnabled])
  );
  const restorable = new Map<string, boolean>();
  for (const [id, wasEnabled] of previous) {
    if (current.get(id) === target && !busyModelIds.has(id)) {
      restorable.set(id, wasEnabled);
    }
  }
  return restorable;
}

function groupByPreviousState(previous: ReadonlyMap<string, boolean>): {
  readonly disable: string[];
  readonly enable: string[];
} {
  const enable: string[] = [];
  const disable: string[] = [];
  for (const [id, wasEnabled] of previous) {
    if (wasEnabled) {
      enable.push(id);
    } else {
      disable.push(id);
    }
  }
  return { disable, enable };
}

/**
 * Bulk enable/disable with Undo (BST-1805 design §6). The write goes through
 * `toggleMany` (one DB statement). On success an Undo toast restores each
 * model's exact prior state in at most two writes, skipping any model changed
 * since (or still being written). Failures are reported by
 * `toggleMany`'s own destructive toast, so this never adds a second one.
 */
export function useModelBulkToggle({
  busyModelIds,
  toggleMany,
}: Pick<ModelToggleController, 'busyModelIds' | 'toggleMany'>): (
  change: ModelBulkChange
) => Promise<boolean> {
  const { toast } = useToast();
  // Undo runs from a toast long after the bulk write; it must see the busy set
  // at click time, not the one captured when the toast was raised.
  const busyRef = useRef(busyModelIds);
  useEffect(() => {
    busyRef.current = busyModelIds;
  }, [busyModelIds]);

  const undo = useCallback(
    async (previous: ReadonlyMap<string, boolean>, target: boolean): Promise<void> => {
      const restorable = restorableEntries(previous, target, busyRef.current);
      const { disable, enable } = groupByPreviousState(restorable);
      const reEnabled = enable.length > 0 ? await toggleMany(enable, true) : null;
      const reDisabled = disable.length > 0 ? await toggleMany(disable, false) : null;
      if (reEnabled?.committed === false || reDisabled?.committed === false) {
        return;
      }
      toast({
        title:
          restorable.size === previous.size
            ? `Restored ${pluralize(previous.size, 'model')}`
            : `Restored ${restorable.size} of ${pluralize(previous.size, 'model')}`,
      });
    },
    [toast, toggleMany]
  );

  return useCallback(
    async ({ enabled, modelIds, scopeLabel }: ModelBulkChange): Promise<boolean> => {
      const outcome = await toggleMany(modelIds, enabled);
      if (!outcome.committed) {
        return false;
      }
      const { previous } = outcome;
      toast({
        action: (
          <ToastAction
            altText={`Undo: restore ${pluralize(previous.size, 'model')}`}
            data-testid="model-bulk-undo"
            onClick={() => {
              void undo(previous, enabled);
            }}
          >
            Undo
          </ToastAction>
        ),
        title: `${enabled ? 'Enabled' : 'Disabled'} ${previous.size} ${scopeLabel} ${pluralNoun(previous.size, 'model')}`,
      });
      return true;
    },
    [toast, toggleMany, undo]
  );
}
