import {
  getProviderDefinition,
  isSupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { useModelToggle } from '@brainstrike/settings-ui/settings/models/use-model-toggle';
import { useToast } from '@brainstrike/ui';
import { useCallback } from 'react';

/**
 * Enabling a model from a `ComposerModelPicker` search result — shared by the
 * main composer (`AssistantUiPanelWrapper`) and the delegated child's
 * next-run picker (`useChildNextRunControls`) so both surfaces enforce the
 * same enable rule instead of drifting (BST-1795 Task 7).
 *
 * Only registry-backed providers (`getProviderDefinition(providerId).runtime`
 * is `'hosted'` or `'gateway'` — the same predicate the picker uses to offer
 * the row) can have their enablement written through `useModelToggle`. Any
 * other provider (local runtimes, or an id the registry doesn't recognize)
 * surfaces a destructive toast and never calls `toggle` — NO SILENT
 * DEGRADATION.
 */
export function useEnableModel(): (providerId: string, modelId: string) => Promise<boolean> {
  const { toggle: toggleModelEnabled } = useModelToggle();
  const { toast } = useToast();

  return useCallback(
    async (providerId: string, modelId: string): Promise<boolean> => {
      if (!isSupportedProvider(providerId)) {
        toast({
          description: `${providerId} is not a known provider.`,
          title: 'Could not enable this model',
          variant: 'destructive',
        });
        return false;
      }
      const { runtime } = getProviderDefinition(providerId);
      // Same predicate the picker uses to offer the row: only hosted and gateway
      // providers keep enablement in the model registry.
      if (runtime !== 'hosted' && runtime !== 'gateway') {
        toast({
          description: `${providerId} models are enabled by their runtime, not the model registry.`,
          title: 'Could not enable this model',
          variant: 'destructive',
        });
        return false;
      }
      // `models.id` is the model registry table's primary key (catalog
      // migrations upsert `ON CONFLICT (id)`), so a bare id identifies
      // exactly one row even though the UI keys selection by
      // `provider::model`.
      return toggleModelEnabled(modelId, true);
    },
    [toast, toggleModelEnabled]
  );
}
