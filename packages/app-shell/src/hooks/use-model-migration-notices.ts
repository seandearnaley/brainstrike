import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { getProviderDisplayName } from '@brainstrike/assistant-contract/provider-metadata';
import { useToast } from '@brainstrike/ui';
import { useEffect } from 'react';

/**
 * BST-565. When the persist migration replaces a retired model id in the
 * user's saved selection, the store records the remap in session-only
 * `modelMigrationNotices`. Surfaces each one as a toast exactly once.
 *
 * Mounted ONCE, in `AppLayout`, so it is present for the whole session
 * (including before any assistant thread is open) and never duplicated per
 * thread tab. The effect subscribes to the list only as a trigger and
 * takes-and-clears from the live store, so StrictMode's re-run and any
 * concurrent mount race to a single non-empty take.
 */
export function useModelMigrationNotices(): void {
  const notices = useAssistantPreferencesStore((state) => state.modelMigrationNotices);
  const { toast } = useToast();

  useEffect(() => {
    const pending =
      notices.length > 0 ? useAssistantPreferencesStore.getState().takeModelMigrationNotices() : [];
    for (const notice of pending) {
      toast({
        description: `${getProviderDisplayName(notice.provider)} no longer offers ${notice.from}. Your selection was moved to ${notice.to} — pick another model if that is not what you want.`,
        // A one-shot startup notice about a downgrade the user never chose
        // must outlive the 5s default: it stays until explicitly closed.
        persistent: true,
        title: 'Saved model replaced',
      });
    }
  }, [notices, toast]);
}
