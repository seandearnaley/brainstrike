import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { useModelToggle } from '@brainstrike/settings-ui/settings/models/use-model-toggle';
import { useToast } from '@brainstrike/ui';
import { useCallback } from 'react';

/**
 * Enabling a model from a `ComposerModelPicker` search result — shared by the
 * main composer (`AssistantUiPanelWrapper`) and the desktop host presentation
 * so both surfaces enforce the same enable rule instead of drifting (BST-1795
 * Task 7).
 *
 * Enablement is written through `useModelToggle`. An id the registry doesn't
 * recognize surfaces a destructive toast and never calls `toggle` — NO SILENT
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
      // `models.id` is the model registry table's primary key (catalog
      // migrations upsert `ON CONFLICT (id)`), so a bare id identifies
      // exactly one row even though the UI keys selection by
      // `provider::model`.
      return toggleModelEnabled(modelId, true);
    },
    [toast, toggleModelEnabled]
  );
}
