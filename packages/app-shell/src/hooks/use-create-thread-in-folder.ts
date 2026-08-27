import {
  createPgliteAssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { toast } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';

export interface ThreadFolderBinding {
  readonly displayName: string;
  readonly path: string | null;
  readonly rootId: string;
}

/**
 * A thread started FROM a folder section is born bound to that folder: one
 * `createThread`, then ONE metadata update carrying the whole binding (the
 * repository rejects a partial operating-root triple, and two writes would
 * leave a window where the thread is bound to half a folder).
 *
 * `operatingRootPath` is omitted when the root has none (a browser
 * file-system-access root): the display name + durable root id ARE the
 * binding, and the path is display-only.
 */
export function useCreateThreadInFolder(): ((folder: ThreadFolderBinding) => void) | null {
  const database = usePGliteDatabase();
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const repository = useMemo(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const createThreadInFolder = useCallback(
    (folder: ThreadFolderBinding): void => {
      if (!repository) {
        return;
      }
      createThread(repository, resourceId)
        .then(async (thread) => {
          try {
            await updateThreadMetadata(repository, resourceId, thread.id, {
              operatingRootDisplayName: folder.displayName,
              operatingRootId: folder.rootId,
              ...(folder.path ? { operatingRootPath: folder.path } : {}),
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            toast({
              description: `Could not bind it to ${folder.displayName}. Open the thread and select ${folder.displayName} to retry. Error: ${message}`,
              title: 'Thread created in No folder',
              variant: 'destructive',
            });
          }
        })
        .catch((error: unknown) => {
          toast({
            description: error instanceof Error ? error.message : String(error),
            title: `New thread in ${folder.displayName} failed`,
            variant: 'destructive',
          });
        });
    },
    [createThread, repository, resourceId, updateThreadMetadata]
  );

  return repository ? createThreadInFolder : null;
}
