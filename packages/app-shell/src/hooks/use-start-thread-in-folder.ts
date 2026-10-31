import {
  type ThreadFolderRow,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';

import { useAssistantThreadHost } from '../assistant-thread-host-context';

/**
 * A thread started FROM a folder opens the new-thread screen bound to that
 * folder. Nothing is created yet: its first send creates the thread and
 * commits the binding (new-thread-welcome.tsx). Null until a thread host is
 * attached, so no surface offers a dead "New Thread Here".
 */
export function useStartThreadInFolder(): ((folder: ThreadFolderRow) => void) | null {
  const host = useAssistantThreadHost();
  const startNewThread = useAssistantThreadStore((state) => state.startNewThread);
  const startThreadInFolder = (folder: ThreadFolderRow): void =>
    startNewThread(WORKSPACE_MEMORY_RESOURCE_ID, folder);
  return host ? startThreadInFolder : null;
}
