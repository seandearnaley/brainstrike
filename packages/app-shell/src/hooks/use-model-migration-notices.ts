import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { getProviderDisplayName } from '@brainstrike/assistant-contract/provider-metadata';
import { useToast } from '@brainstrike/ui';
import { useEffect } from 'react';

/**
 * BST-565. When the persist migration replaces a retired model id in the
 * user's saved selection, the store records the remap in session-only
 * `modelMigrationNotices`. Surfaces each one as a toast exactly once, then
 * dismisses them. The dismiss is unconditional and the store treats an
 * already-empty list as a no-op, so hydration order and re-renders cannot
 * repeat a toast.
 */
export function useModelMigrationNotices(): void {
  const notices = useAssistantPreferencesStore((state) => state.modelMigrationNotices);
  const dismiss = useAssistantPreferencesStore((state) => state.dismissModelMigrationNotices);
  const { toast } = useToast();

  useEffect(() => {
    for (const notice of notices) {
      toast({
        description: `${getProviderDisplayName(notice.provider)} no longer offers ${notice.from}. Your selection was moved to ${notice.to} — pick another model if that is not what you want.`,
        title: 'Saved model replaced',
      });
    }
    dismiss();
  }, [dismiss, notices, toast]);
}
