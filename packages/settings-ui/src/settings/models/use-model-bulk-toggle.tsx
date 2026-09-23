import { ToastAction, useToast } from '@brainstrike/ui';
import { useCallback } from 'react';
import { pluralize, pluralNoun } from './catalog-format';
import type { ModelToggleController } from './use-model-toggle';

export interface ModelBulkChange {
  readonly enabled: boolean;
  /** Only the ids whose state actually changes (the caller filters). */
  readonly modelIds: readonly string[];
  /** Who the change is about: "OpenRouter" → "Disabled 59 OpenRouter models". */
  readonly scopeLabel: string;
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
 * model's exact prior state in at most two writes. Failures are reported by
 * `toggleMany`'s own destructive toast, so this never adds a second one.
 */
export function useModelBulkToggle(
  toggleMany: ModelToggleController['toggleMany']
): (change: ModelBulkChange) => Promise<boolean> {
  const { toast } = useToast();

  const undo = useCallback(
    async (previous: ReadonlyMap<string, boolean>): Promise<void> => {
      const { disable, enable } = groupByPreviousState(previous);
      const reEnabled = enable.length > 0 ? await toggleMany(enable, true) : null;
      const reDisabled = disable.length > 0 ? await toggleMany(disable, false) : null;
      if (reEnabled?.committed === false || reDisabled?.committed === false) {
        return;
      }
      toast({ title: `Restored ${pluralize(previous.size, 'model')}` });
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
              void undo(previous);
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
